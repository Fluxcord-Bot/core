import { ChannelType as FluxerChannelType, MessageType } from "@fluxerjs/core";
import { BridgeEndpoint, BridgeGroup, MessageLink } from "../db/index.js";
import Config from "../utils/ConfigHandler.js";
import { CommandHandler } from "./CommandHandler.js";
import { cloudUploadAttachments } from "./CloudUpload.js";
import { Op } from "sequelize";
import { readFileSync } from "node:fs";
import { parseFluxerEmojiToDiscord, traverseMessageLinks } from "./EmojiStickerParser.js";
import { fluxerEmbedToDiscord } from "./EmbedConverter.js";
import { parseMentions } from "./MessageContentParser.js";
import { sanitizePings } from "./SanitizePings.js";
import { log } from "./Logger.js";
import { getGuildPrefix } from "./GetGuildPrefix.js";
import { sendFluxerWebhook, editFluxerWebhook } from "./FluxerWebhookSend.js";
import { getDiscordWebhook } from "./Webhooks.js";
import { processReplyContent } from "./ProcessReplyContent.js";
import { getFluxerMediaBaseUrl } from "./GetFluxerUrls.js";
import { isFluxerSpoilerAttachment, toDiscordSpoilerFilename } from "./SpoilerAttachments.js";
import { checkEmbedPerms, checkPingPerms } from "./CheckManageServerPerms.js";
import { cacheUser, resolveMentions } from "./MentionResolver.js";
import { resetBridgeHealth } from "./BridgeHealth.js";
import { isBridgeToggleEnabled } from "./BridgeToggle.js";
import { indicatorPrefix, resolveNameIndicator, withIndicator } from "./NameIndicator.js";
import { resolveDiscordThreadChannel } from "./DiscordThreadResolver.js";
import { autoBridgeFluxerThread, backfillMirroredThread, waitForPendingMirror } from "./ThreadMirror.js";
import { processSticker } from "./StickerProcessor.js";
import { maybePublishDiscordMessage } from "./AnnouncementPublish.js";
import { canUserBridge, promptOptedOutUserOnFirstMessage } from "./UserOptOut.js";
import { ensureLink, findEndpoints, findLinkSiblings, getRelay, newLinkGroup, recordRelay } from "./Bridging.js";
import { waitForMessageMap } from "./WaitForMessageMap.js";
import { deleteLogicalMessage, rewriteRepliesForDeleted } from "./LogicalMessage.js";
import { resolveFluxerClient } from "./FluxerClients.js";
/**
 * @typedef {Object} TargetCtx
 * @property {string} channelId
 * @property {string} guildId
 * @property {"discord" | "fluxer"} platform
 * @property {any} [nameIndicator]
 */
import { normalizeFcJson } from "./NormalizeJson.js";

let fluxcordBotEmojiCfg = undefined;

const MAX_ATTACHMENT_SIZE = 19999000;

function replyLine(platform = "discord", instanceId = null) {
  if (platform === "fluxer") {
    const fluxerReplies = fluxcordBotEmojiCfg?.fluxerReplyEmoji;
    const entry = fluxerReplies?.[instanceId] ?? fluxerReplies?.default ?? Object.values(fluxerReplies ?? {})[0];
    if (!entry?.replyL || !entry?.replyR) return "";
    return `-# ${entry.replyL}${entry.replyR} `;
  }
  const discordReply = fluxcordBotEmojiCfg?.discordReplyEmoji;
  if (!discordReply?.replyL || !discordReply?.replyR) return "";
  return `-# <:reply_l:${discordReply.replyL}><:reply_r:${discordReply.replyR}> `;
}

function directionAllowed(sourcePlatform, targetPlatform, bridgeType) {
  if (sourcePlatform === targetPlatform) return bridgeType === "both";
  if (sourcePlatform === "fluxer") return bridgeType !== "discord2fluxer";
  return bridgeType !== "fluxer2discord";
}

/**
 * @param {any[]} sourceEndpoints
 * @param {"discord" | "fluxer"} sourcePlatform
 * @param {{ excludeGroupIds?: number[], kind: "channel" | "thread", excludeChannelId: string }} opts
 * @returns {Promise<{ key: string, endpoints: any[], bridgeType: string }[]>}
 */
async function collectTargets(sourceEndpoints, sourcePlatform, opts = {}) {
  const { excludeGroupIds = [], kind, excludeChannelId } = opts;

  const groupIds = [...new Set(sourceEndpoints.map(e => e.groupId))].filter(id => !excludeGroupIds.includes(id));
  if (groupIds.length === 0) return [];

  const groups = await BridgeGroup.findAll({ where: { id: { [Op.in]: groupIds } }, raw: true });
  const typeById = new Map(groups.map(g => [g.id, g.bridgeType]));

  const candidates = await BridgeEndpoint.findAll({ where: { groupId: { [Op.in]: groupIds } }, raw: true });

  const byChannel = new Map();
  for (const t of candidates) {
    if (t.platform === sourcePlatform && t.channelId === excludeChannelId) continue;
    if (t.kind !== kind) continue;
    if (!directionAllowed(sourcePlatform, t.platform, typeById.get(t.groupId))) continue;
    const key = `${t.platform}:${t.channelId}`;
    let entry = byChannel.get(key);
    if (!entry) {
      entry = { key, endpoints: [], bridgeType: typeById.get(t.groupId) };
      byChannel.set(key, entry);
    }
    entry.endpoints.push(t);
  }

  return [...byChannel.values()];
}

/**
 * @param {string} targetChannelId
 * @param {string | null} refMessageId
 * @returns {Promise<(MessageLink & { endpoint?: BridgeEndpoint })?>}
 */
async function findReplyCopy(targetChannelId, refMessageId) {
  if (!refMessageId) return null;
  const refLink = await MessageLink.findOne({ where: { messageId: refMessageId } });
  if (!refLink) return null;
  const siblings = await findLinkSiblings(refLink.linkGroup);
  return siblings.find(s => s.endpoint?.channelId === targetChannelId) ?? null;
}

/**
 * @param {TargetCtx} target
 * @param {string | null} refMessageId source-local reply id
 * @param {any} refMessage resolved referenced message on the source platform
 * @returns {Promise<string>}
 */
async function replyLineFor(target, refMessageId, refMessage) {
  if (!refMessageId) return "";
  const local = await findReplyCopy(target.channelId, refMessageId);
  const targetPlatform = target.platform ?? "discord";
  if (local) {
    const platform = local.endpoint?.platform;
    let authorLabel;
    if (platform === "discord") {
      authorLabel = `${indicatorPrefix("discord", target.nameIndicator ?? undefined)}<@${local.authorId}>`;
    } else {
      const disc = refMessage?.author?.discriminator;
      authorLabel = `${indicatorPrefix("fluxer", target.nameIndicator ?? undefined)}@${refMessage?.author?.username ?? "unknown-user"}${disc && disc !== "0000" ? `#${disc}` : ""}`;
    }
    const body = refMessage ? await processReplyContent(refMessage) : "*original message*";
    let line = `${replyLine(targetPlatform, target.instanceId)}${authorLabel}: [${body}`;
    if (platform === "discord") {
      line += `](<https://discord.com/channels/${local.endpoint.guildId}/${local.endpoint.channelId}/${local.messageId}>)`;
    } else {
      line += `](<${local.messageId}>)`;
    }
    return `${line}\n`;
  }
  if (refMessage) {
    const disc = refMessage.author?.discriminator;
    const authorLabel = `${indicatorPrefix("fluxer", target.nameIndicator ?? undefined)}@${refMessage.author?.username ?? "unknown-user"}${disc && disc !== "0000" ? `#${disc}` : ""}`;
    return `${replyLine(targetPlatform, target.instanceId)}${authorLabel}: [${await processReplyContent(refMessage)}](${refMessage.id})\n`;
  }
  return `${replyLine(targetPlatform, target.instanceId)}Unbridged message\n`;
}

/**
 * @param {string} url
 * @returns {Promise<Buffer?>}
 */
async function downloadFluxerAttachment(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 1) {
        log("FLUXER", `Failed to download Fluxer attachment ${url}`, e);
        return null;
      }
    }
  }
  return null;
}

/**
 * @param {import("@fluxerjs/core").Message} message
 * @param {import("@fluxerjs/core").Client} client
 * @returns {Promise<any?>}
 */
async function resolveFluxerReference(message, client) {
  if (message.referencedMessage) return message.referencedMessage;

  const reference = message.messageReference;
  if (!reference?.messageId || reference.type === 1) return null;

  try {
    const channel =
      reference.channelId && reference.channelId !== message.channelId
        ? await client.channels.fetch(reference.channelId)
        : (message.channel ?? (await client.channels.fetch(message.channelId)));

    if (channel?.isTextBased?.() && channel.messages) {
      return await channel.messages.fetch(reference.messageId);
    }
  } catch {}

  return null;
}

/**
 * @param {any} user
 * @param {any} member
 * @param {string} [instanceId]
 * @returns {Promise<string | undefined>}
 */
async function getFluxerAvatarURL(user, member, instanceId = "default") {
  if (!user?.avatarURL) return undefined;
  const avatar = member?.avatar ?? user.avatar;
  if (!avatar) {
    return user.avatarURL() ?? undefined;
  }

  const mediaBase = (await getFluxerMediaBaseUrl(instanceId).catch(() => undefined)) ?? Config.FluxerCDNBaseURL;
  const cdnBase = mediaBase.replace(/\/$/, "");
  const extension = avatar.startsWith("a_") ? "gif" : "webp";
  const path = member?.avatar ? `guilds/${member?.guild?.id ?? ""}/users/${user.id}/avatars` : `avatars/${user.id}`;

  return `${cdnBase}/${path}/${avatar}.${extension}?size=160`;
}

/**
 * @param {any} error
 * @returns {boolean}
 */
function isFluxerMessageNotFoundError(error) {
  return (
    error?.code === "MESSAGE_NOT_FOUND" ||
    error?.code === "UNKNOWN_MESSAGE" ||
    error?.statusCode === 404 ||
    (error?.cause?.statusCode === 404 && /message .* not found/i.test(error?.message ?? ""))
  );
}

/**
 * @param {string} threadId
 * @param {string} parentId
 * @param {import("@fluxerjs/core").Client} client
 * @param {import("discord.js").Client} discordClient
 * @param {string} instanceId
 * @returns {Promise<any[]>}
 */
async function mirrorExistingThread(threadId, parentId, client, discordClient, instanceId) {
  const parentEndpoints = await findEndpoints("fluxer", parentId);
  if (parentEndpoints.length === 0) return [];
  const thread = await client.channels.fetch(threadId).catch(() => null);
  if (!thread || thread.type === FluxerChannelType.PrivateThread) return [];
  const rows = await autoBridgeFluxerThread(thread, parentEndpoints, discordClient, client);
  if (!rows.length) return [];
  log("DEBUG", `FluxerCreate mirrored on activity thread ${thread.id}`);
  await backfillMirroredThread(
    thread,
    async message => await FluxerCreateMessageHandler(message, client, discordClient, { instanceId, execCommands: false })
  );
  return rows;
}

/**
 * @typedef {Object} FluxerCreateOptions
 * @property {string} [instanceId]
 * @property {boolean} [execCommands]
 */

/**
 * @param {import("@fluxerjs/core").Message} message
 * @param {import("@fluxerjs/core").Client} client
 * @param {import("discord.js").Client} discordClient
 * @param {FluxerCreateOptions} [options]
 */
export async function FluxerCreateMessageHandler(message, client, discordClient, options = {}) {
  const instanceId = options.instanceId ?? "default";
  log(
    "DEBUG",
    `FluxerCreate received id=${message.id} channelId=${message.channelId} guildId=${message.guildId} authorId=${message.author?.id} type=${message.type} hasReference=${Boolean(message.messageReference)} instance=${instanceId}`
  );
  cacheUser(message.author, "fluxer");

  if (!fluxcordBotEmojiCfg) {
    fluxcordBotEmojiCfg = normalizeFcJson(JSON.parse(readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8")));
  }

  const guildId = message.guildId;

  if (
    !guildId ||
    message.type === 4 ||
    message.type === 5 ||
    message.type === 6 ||
    message.type === 18 ||
    message.type === MessageType.ThreadStarterMessage ||
    message.id === message.channelId
  ) {
    log("DEBUG", `FluxerCreate skip id=${message.id} reason=unsupportedGuildOrType type=${message.type}`);
    return;
  }

  const initialMessage = message.content;

  const guildPrefix = await getGuildPrefix(guildId);
  if (message.content.startsWith(guildPrefix)) {
    log("DEBUG", `FluxerCreate id=${message.id} isCommand=${options.execCommands !== false}`);
    if (options.execCommands === false) return;
    await CommandHandler(message, discordClient, client);
    return;
  }

  if (!discordClient.token) {
    log("DEBUG", `FluxerCreate skip id=${message.id} reason=discordClientUnavailable`);
    return;
  }

  let endpoints = await findEndpoints("fluxer", message.channelId);

  if (endpoints.length === 0) {
    const known = message.channel;
    const thread = known?.isThread?.() ? known : known ? null : await client.channels.fetch(message.channelId).catch(() => null);
    if (thread?.isThread?.()) {
      const pending = await waitForPendingMirror("fluxer", message.channelId);
      if (pending?.length) {
        endpoints = pending;
        log("DEBUG", `FluxerCreate id=${message.id} resolved pending mirror for thread ${message.channelId}`);
      } else if (thread.parentId) {
        const rows = await mirrorExistingThread(message.channelId, thread.parentId, client, discordClient, instanceId);
        if (rows.length) return;
        endpoints = await findEndpoints("fluxer", message.channelId);
        if (endpoints.length === 0) {
          log("DEBUG", `FluxerCreate skip id=${message.id} channelId=${message.channelId} reason=unbridgedThread`);
          return;
        }
      }
    }
  }

  if (endpoints.length === 0) {
    log("DEBUG", `FluxerCreate skip id=${message.id} channelId=${message.channelId} reason=noEndpoints`);
    return;
  }

  const relayWebhookId = message.webhookId ?? message.author?.id ?? null;
  let relay = null;
  let relayEndpoint = null;
  for (const e of endpoints) {
    if (!e.webhookId || e.webhookId !== relayWebhookId) continue;
    const record = getRelay(e.id, relayWebhookId);
    if (record) {
      relay = record;
      relayEndpoint = e;
      break;
    }
    if (!relayEndpoint) relayEndpoint = e;
  }

  if (relayEndpoint && !relay) {
    log("DEBUG", `FluxerCreate skip id=${message.id} authorId=${relayWebhookId} reason=webhookEcho`);
    return;
  }

  if (relay) {
    await propagateRelayEcho(message, relayEndpoint, relay, discordClient);
    return;
  }

  if (!(await canUserBridge("fluxer", message.author.id, guildId))) {
    const guildName = message.guild?.name ?? guildId;
    await promptOptedOutUserOnFirstMessage(guildId, "fluxer", message.author, guildName);
    log("DEBUG", `FluxerCreate skip id=${message.id} authorId=${message.author.id} reason=userOptOut`);
    return;
  }

  const kind = endpoints.some(e => e.kind === "thread") ? "thread" : "channel";

  const isCrosspostCpy = message.flags?.has?.(2) === true;

  let forwardedMessage = null;
  if (message.messageReference?.type === 1) forwardedMessage = message.messageSnapshots?.[0];

  const refMessageId =
    !forwardedMessage && !isCrosspostCpy && message.messageReference?.type !== 1
      ? (message.messageReference?.messageId ?? null)
      : null;

  let refMessage = null;
  if (refMessageId) {
    refMessage = await resolveFluxerReference(message, client);
    await waitForMessageMap("fluxer", refMessageId, refMessage?.author?.id, refMessage?.createdAt, guildId);
  }

  const linkGroup = newLinkGroup();
  for (const e of endpoints) {
    try {
      await MessageLink.create({
        linkGroup,
        endpointId: e.id,
        messageId: message.id,
        replyId: refMessageId,
        authorId: message.author.id,
      });
    } catch (e) {
      log("DB", `Failed to create source message link message=${message.id}`, e);
    }
  }

  const targets = await collectTargets(endpoints, "fluxer", { kind, excludeChannelId: message.channelId });

  let sentAny = false;

  for (const entry of targets) {
    let sent = null;
    if (entry.endpoints[0].platform === "discord") {
      sent = await sendToDiscordTarget(
        message,
        forwardedMessage,
        refMessageId,
        refMessage,
        entry,
        linkGroup,
        discordClient,
        client,
        instanceId
      );
    } else {
      sent = await sendToFluxerTarget(message, forwardedMessage, refMessageId, refMessage, entry, linkGroup, null, instanceId);
    }
    if (sent) sentAny = true;
  }

  if (sentAny) resetBridgeHealth(guildId);

  const checkMsg = async () => {
    const channel = message.channel;
    if (channel?.isTextBased() && channel.messages) {
      try {
        const fetchedMsg = await channel.messages.fetch(message.id);
        if (fetchedMsg.content !== initialMessage || fetchedMsg.editedAt) {
          await FluxerUpdateMessageHandler(fetchedMsg, fetchedMsg, discordClient, { instanceId });
        }
      } catch (e) {
        if (isFluxerMessageNotFoundError(e)) {
          await deleteLogicalMessage(linkGroup, discordClient);
          return;
        }

        log("FLUXER", "Source message fetch failed", e);
      }
    }
  };
  setTimeout(checkMsg, 1000);
  setTimeout(checkMsg, 2500);
  setTimeout(checkMsg, 5000);
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {{ endpoints: any[] }} entry
 * @returns {Promise<{ endpoint: any, threadId: string | null }>}
 */
async function resolveDiscordPostTarget(discordClient, entry) {
  const endpoint = entry.endpoints[0];
  const discordThread = await resolveDiscordThreadChannel(discordClient, endpoint.channelId).catch(() => null);
  if (discordThread?.archived && !discordThread.locked) {
    try {
      await discordThread.setArchived(false);
    } catch (e) {
      log("DISCORD", `Failed to unarchive bridged Discord thread ${discordThread.id}`, e);
    }
  }
  return { endpoint, threadId: discordThread?.id ?? null };
}

/**
 * @param {import("@fluxerjs/core").Message} message
 * @param {any} forwardedMessage
 * @param {string | null} refMessageId
 * @param {any} refMessage
 * @param {{ endpoints: any[] }} entry
 * @param {string} linkGroup
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} client
 * @param {string} sourceInstanceId
 * @param {number | null} [sourceGroupId]
 * @returns {Promise<any | null>}
 */
async function sendToDiscordTarget(
  message,
  forwardedMessage,
  refMessageId,
  refMessage,
  entry,
  linkGroup,
  discordClient,
  client,
  sourceInstanceId,
  sourceGroupId = null
) {
  const postTarget = await resolveDiscordPostTarget(discordClient, entry);
  const targetEndpoint = postTarget.endpoint;

  let delivered = true;
  for (const endpoint of entry.endpoints) {
    const existing = await ensureLink(linkGroup, endpoint.id, message.id, refMessageId, message.author?.id);
    if (existing && endpoint.id === targetEndpoint.id) delivered = false;
  }
  if (!delivered) {
    log("DEBUG", `FluxerCreate skip target endpoint=${targetEndpoint.id} message=${message.id} reason=alreadyLinked`);
    return null;
  }

  let nameIndicator = undefined;
  try {
    nameIndicator = await resolveNameIndicator(targetEndpoint.guildId, message.guildId);
  } catch {}
  const prefix = indicatorPrefix("fluxer", nameIndicator);
  const userSuffix =
    message.type === 7
      ? `*${prefix}@${message.author.username}${message.author.discriminator !== "0000" ? `#${message.author.discriminator}` : ""} joined the bridged community*`
      : "";

  const mediaBase = (await getFluxerMediaBaseUrl(sourceInstanceId).catch(() => undefined)) ?? Config.FluxerCDNBaseURL;

  const stickerFiles = [];
  const stickerFallbacks = [];

  for (const sticker of message.stickers ?? []) {
    const url = `${mediaBase}/stickers/${sticker.id}.webp?size=320&animated=${sticker.animated}`;
    const processed = await processSticker(url, {
      animated: sticker.animated,
      name: sticker.name,
    });

    if (processed) {
      stickerFiles.push({ name: processed.filename, attachment: processed.buffer });
    } else {
      stickerFallbacks.push(`[${sticker.name}](${url})`);
    }
  }

  const stickerMsg = stickerFallbacks.join(", ");

  const source = forwardedMessage ?? message;

  const overAttachments = source.attachments?.filter(x => x.size > MAX_ATTACHMENT_SIZE) ?? [];
  const overAttachmentsStr = overAttachments.map(x => `[${x.filename}](<${x.proxyUrl ?? x.url}>)`).join(" ");
  const okAttachments = source.attachments?.filter(x => x.size <= MAX_ATTACHMENT_SIZE) ?? [];

  const webhook = await getDiscordWebhook(discordClient, targetEndpoint);

  const canUserEmbed = message.webhookId
    ? true
    : await checkEmbedPerms(message.guildId, message.channelId, message.author.id, client);

  const canUserPing = await checkPingPerms(message.guildId, message.author.id, client);
  const everyonePings = await isBridgeToggleEnabled(targetEndpoint, "everyonePingEnabled");
  const canBridgePing = canUserPing && everyonePings;

  const otherSideGuild = await discordClient.guilds.fetch(targetEndpoint.guildId);

  const parsedContent = await traverseMessageLinks(
    await parseFluxerEmojiToDiscord(
      await resolveMentions(
        otherSideGuild,
        sanitizePings(await parseMentions(source, null, otherSideGuild), canBridgePing && !forwardedMessage)
      ),
      discordClient,
      targetEndpoint.guildId,
      sourceInstanceId
    )
  );

  let followNotice = parsedContent;
  if (message.type === 12) {
    followNotice = `**${prefix}@${message.author.username}${message.author.discriminator !== "0000" ? `#${message.author.discriminator}` : ""}** has added **${parsedContent}** to this channel. Its most important updates will show up here.`;
  }

  const attachmentDescs = okAttachments.map(a => ({
    url: a.proxyUrl ?? a.url ?? "",
    name: toDiscordSpoilerFilename(a.filename, isFluxerSpoilerAttachment(a)),
    description: a.description,
  }));

  const files = [];
  for (const desc of attachmentDescs) {
    if (!desc.url) continue;
    const data = await downloadFluxerAttachment(desc.url);
    if (!data) continue;
    files.push({
      attachment: data,
      name: desc.name,
      description: desc.description,
    });
  }

  files.push(...stickerFiles);

  const attachments = files.length > 0 ? await cloudUploadAttachments(discordClient, targetEndpoint.channelId, files) : undefined;

  const silentFlag = message.flags?.has?.(4096) ? 4096 : undefined;

  const replyHeader = refMessageId
    ? await replyLineFor(
        { channelId: targetEndpoint.channelId, guildId: targetEndpoint.guildId, platform: "discord", nameIndicator },
        refMessageId,
        refMessage
      )
    : "";

  const webhookPayload = {
    content:
      (forwardedMessage ? `${replyLine("discord")}Forwarded message\n` : "") +
      replyHeader +
      followNotice +
      userSuffix +
      stickerMsg +
      (overAttachmentsStr ? "\n-# has attachments over 20mb: " + overAttachmentsStr : ""),
    attachments,
    username: withIndicator(message.author.globalName ?? message.author.username, "fluxer", nameIndicator),
    embeds: await fluxerEmbedToDiscord(source, discordClient),
    avatarURL: await getFluxerAvatarURL(message.author, undefined, sourceInstanceId),
    allowedMentions: { parse: [] },
    flags: (silentFlag ?? 0) | (canUserEmbed ? 0 : 4),
    ...(postTarget.threadId ? { threadId: postTarget.threadId } : {}),
  };

  let sent;
  try {
    sent = await webhook.send(webhookPayload);
  } catch (e) {
    log("DISCORD", `Failed to bridge Fluxer message ${message.id}`, e);
    return null;
  }

  recordRelay(targetEndpoint.id, targetEndpoint.webhookId, linkGroup, sourceGroupId);

  try {
    await maybePublishDiscordMessage(discordClient, targetEndpoint, sent.id);
  } catch {}

  log(
    "DEBUG",
    `FluxerCreate bridged fluxerId=${message.id} discordId=${sent.id} endpoint=${targetEndpoint.id} fileCount=${files.length} hasThread=${Boolean(postTarget.threadId)}`
  );
  return sent;
}

/**
 * @param {import("@fluxerjs/core").Message} message
 * @param {any} forwardedMessage
 * @param {string | null} refMessageId
 * @param {any} refMessage
 * @param {{ endpoints: any[] }} entry
 * @param {string} linkGroup
 * @param {number | null} [sourceGroupId]
 * @returns {Promise<any | null>}
 */
async function sendToFluxerTarget(
  message,
  forwardedMessage,
  refMessageId,
  refMessage,
  entry,
  linkGroup,
  sourceGroupId = null,
  sourceInstanceId = null
) {
  const targetEndpoint = entry.endpoints[0];
  const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);

  let delivered = true;
  for (const endpoint of entry.endpoints) {
    const existing = await ensureLink(linkGroup, endpoint.id, message.id, refMessageId, message.author?.id);
    if (existing && endpoint.id === targetEndpoint.id) delivered = false;
  }
  if (!delivered) {
    log(
      "DEBUG",
      `FluxerCreate skip same-platform target endpoint=${targetEndpoint.id} message=${message.id} reason=alreadyLinked`
    );
    return null;
  }

  const targetGuild = await fluxerClient.guilds.fetch(targetEndpoint.guildId).catch(() => null);
  if (!targetGuild) {
    log("FLUXER", `Failed to fetch fluxer guild for endpoint ${targetEndpoint.id} (guild ${targetEndpoint.guildId})`);
    return null;
  }

  let nameIndicator = undefined;
  try {
    nameIndicator = await resolveNameIndicator(targetEndpoint.guildId, message.guildId);
  } catch {}
  let prefix = "";
  try {
    prefix = indicatorPrefix("fluxer", nameIndicator);
  } catch {}

  const source = forwardedMessage ?? message;
  let parsedContent = source.content ?? "";
  try {
    parsedContent = await resolveMentions(targetGuild, await parseMentions(source, source.content ?? "", targetGuild, "fluxer"));
  } catch (e) {
    log("FLUXER", `Failed to convert content for same-platform target of message ${message.id}`, e);
  }
  parsedContent = sanitizePings(parsedContent, true);

  let userSuffix = "";
  if (message.type === 7) {
    userSuffix = `*${prefix}@${message.author.username}${message.author.discriminator !== "0000" ? `#${message.author.discriminator}` : ""} joined the bridged community*`;
  }

  const okAttachments = source.attachments?.filter(a => a.size <= MAX_ATTACHMENT_SIZE) ?? [];
  const files = okAttachments.map(a => ({ url: a.proxyUrl ?? a.url, name: a.filename, description: a.description }));

  const overAttachments = source.attachments?.filter(a => a.size > MAX_ATTACHMENT_SIZE) ?? [];
  const overAttachmentsStr = overAttachments.map(x => `[${x.filename}](<${x.proxyUrl ?? x.url}>)`).join(" ");

  const replyHeader = await replyLineFor(
    { channelId: targetEndpoint.channelId, guildId: targetEndpoint.guildId, platform: "fluxer", nameIndicator },
    refMessageId,
    refMessage
  );

  const payload = {
    content:
      (forwardedMessage ? `${replyLine("fluxer", targetEndpoint.instanceId)}Forwarded message\n` : "") +
      replyHeader +
      parsedContent +
      userSuffix +
      (overAttachmentsStr ? `\n-# has attachments over 20mb: ${overAttachmentsStr}` : ""),
    embeds: source.embeds ?? [],
    username: withIndicator(message.author.globalName ?? message.author.username, "fluxer", nameIndicator),
    avatarURL: await getFluxerAvatarURL(message.author, undefined, sourceInstanceId ?? targetEndpoint.instanceId),
    allowedMentions: { parse: [] },
    ...(files.length > 0 ? { files } : {}),
  };

  let sent;
  try {
    if (targetEndpoint.webhookId) {
      sent = await sendFluxerWebhook(targetEndpoint.webhookId, targetEndpoint.webhookToken, fluxerClient, {
        ...payload,
        ...(targetEndpoint.kind === "thread" ? { threadId: targetEndpoint.channelId } : {}),
      });
    } else {
      const channel = await fluxerClient.channels.fetch(targetEndpoint.channelId);
      sent = await channel.send({
        content: payload.content,
        embeds: payload.embeds,
        ...(files.length > 0 ? { files } : {}),
        allowedMentions: { parse: ["users", "roles", "everyone"] },
      });
    }
  } catch (e) {
    log("FLUXER", `Failed to send message into Fluxer channel ${targetEndpoint.channelId}`, e);
    return null;
  }

  recordRelay(targetEndpoint.id, targetEndpoint.webhookId ?? sent?.webhook_id ?? null, linkGroup, sourceGroupId);

  log(
    "DEBUG",
    `FluxerCreate bridged fluxerId=${message.id} fluxerTargetId=${sent?.id} instance=${targetEndpoint.instanceId} endpoint=${targetEndpoint.id}`
  );
  return sent;
}

/**
 * @param {import("@fluxerjs/core").Message} message
 * @param {any} relayEndpoint
 * @param {{ linkGroup: string, sourceGroupId: number }} relay
 * @param {import("discord.js").Client} discordClient
 * @returns {Promise<void>}
 */
async function propagateRelayEcho(message, relayEndpoint, relay, discordClient) {
  const linkGroup = relay.linkGroup;
  const sourceGroupId = relay.sourceGroupId;

  const channelEndpoints = await BridgeEndpoint.findAll({
    where: { platform: "fluxer", channelId: relayEndpoint.channelId },
    raw: true,
  });
  if (channelEndpoints.length === 0) return;

  const linkedRows = await MessageLink.findAll({ where: { linkGroup }, attributes: ["endpointId"], raw: true });
  const linkedEndpointIds = new Set(linkedRows.map(l => l.endpointId));
  const linkedGroupIds = [...new Set(channelEndpoints.filter(e => linkedEndpointIds.has(e.id)).map(e => e.groupId))];

  const targets = await collectTargets(channelEndpoints, "fluxer", {
    excludeGroupIds: [...new Set([sourceGroupId, ...linkedGroupIds].filter(g => g != null))],
    kind: relayEndpoint.kind,
    excludeChannelId: relayEndpoint.channelId,
  });

  for (const entry of targets) {
    let isNew = false;
    for (const endpoint of entry.endpoints) {
      const existing = await ensureLink(linkGroup, endpoint.id, message.id, null, null);
      if (!existing) isNew = true;
    }
    if (!isNew) {
      log("DEBUG", `RelayEcho skip target entry=${entry.key} group=${linkGroup} reason=alreadyLinked`);
      continue;
    }

    const attachmentFiles = (message.attachments ?? [])
      .filter(a => a.size <= MAX_ATTACHMENT_SIZE)
      .map(a => ({ url: a.proxyUrl ?? a.url, name: a.filename }));

    if (entry.endpoints[0].platform === "discord") {
      const postTarget = await resolveDiscordPostTarget(discordClient, entry);
      const webhook = await getDiscordWebhook(discordClient, postTarget.endpoint);
      try {
        await webhook.send({
          content: message.content,
          embeds: message.embeds ?? [],
          ...(attachmentFiles.length > 0 ? { files: attachmentFiles.map(a => ({ attachment: a.url, name: a.name })) } : {}),
          ...(postTarget.threadId ? { threadId: postTarget.threadId } : {}),
        });
      } catch (e) {
        log("DISCORD", `Failed to relay message to ${postTarget.endpoint.channelId}`, e);
      }
      recordRelay(postTarget.endpoint.id, postTarget.endpoint.webhookId, linkGroup, sourceGroupId);
    } else {
      const endpoint = entry.endpoints[0];
      const fluxerClient = resolveFluxerClient(endpoint.instanceId);

      let relayAuthor = null;
      let relayMember = null;
      try {
        const firstLink = await MessageLink.findOne({ where: { linkGroup }, order: [["id", "ASC"]] });
        if (firstLink?.authorId) {
          relayAuthor = await message.client.users.fetch(firstLink.authorId).catch(() => null);
          if (relayAuthor) {
            relayMember = await message.client.guilds
              .fetch(relayEndpoint.guildId)
              .then(g => g.members.fetch(relayAuthor.id))
              .catch(() => null);
          }
        }
      } catch {}

      try {
        if (endpoint.webhookId) {
          await sendFluxerWebhook(endpoint.webhookId, endpoint.webhookToken, fluxerClient, {
            content: message.content,
            embeds: message.embeds ?? [],
            ...(attachmentFiles.length > 0 ? { files: attachmentFiles } : {}),
            username: relayAuthor ? (relayAuthor.globalName ?? relayAuthor.username) : undefined,
            avatarURL: relayAuthor ? await getFluxerAvatarURL(relayAuthor, relayMember, relayEndpoint.instanceId) : undefined,
            ...(endpoint.kind === "thread" ? { threadId: endpoint.channelId } : {}),
          });
        } else {
          const channel = await fluxerClient.channels.fetch(endpoint.channelId);
          await channel.send({
            content: message.content,
            embeds: message.embeds ?? [],
          });
        }
      } catch (e) {
        log("FLUXER", `Failed to relay message to ${endpoint.channelId}`, e);
      }
      recordRelay(endpoint.id, endpoint.webhookId ?? null, linkGroup, sourceGroupId);
    }
  }
}

/**
 * @param {any} oldMessage
 * @param {import("@fluxerjs/core").Message | import("@fluxerjs/core").PartialMessage} newMessage
 * @param {import("discord.js").Client} client
 * @param {FluxerCreateOptions} [options]
 */
export async function FluxerUpdateMessageHandler(oldMessage, newMessage, client, options = {}) {
  const instanceId = options.instanceId ?? "default";
  log(
    "DEBUG",
    `FluxerUpdate received id=${newMessage.id} channelId=${newMessage.channelId} guildId=${newMessage.guildId} authorId=${newMessage.author?.id} partial=${Boolean(newMessage.partial)} instance=${instanceId}`
  );
  if (newMessage.partial) return;

  if (!fluxcordBotEmojiCfg) {
    fluxcordBotEmojiCfg = normalizeFcJson(JSON.parse(readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8")));
  }

  if (newMessage.flags?.has?.(32) && !(oldMessage && !oldMessage.partial && oldMessage.flags?.has?.(32))) {
    log("DEBUG", `FluxerUpdate skip id=${newMessage.id} reason=threadCreated`);
    return;
  }

  if (!(await canUserBridge("fluxer", newMessage.author?.id, newMessage.guildId))) {
    log("DEBUG", `FluxerUpdate skip id=${newMessage.id} authorId=${newMessage.author?.id} reason=userOptOut`);
    return;
  }

  const relayWebhookId = newMessage.webhookId ?? newMessage.author?.id ?? null;
  if (relayWebhookId) {
    const echoRow = await BridgeEndpoint.findOne({
      where: { platform: "fluxer", channelId: newMessage.channelId, webhookId: relayWebhookId },
      raw: true,
    });
    if (echoRow) {
      log("DEBUG", `FluxerUpdate skip id=${newMessage.id} reason=webhookEcho`);
      return;
    }
  }

  const isCrosspostCopy = newMessage.flags?.has?.(2) === true;
  const refMessageId =
    !isCrosspostCopy && newMessage.messageReference?.type !== 1 ? (newMessage.messageReference?.messageId ?? null) : null;

  let refMessageForUpdate = null;
  if (refMessageId) refMessageForUpdate = await resolveFluxerReference(newMessage, newMessage.client);

  const linkRows = await MessageLink.findAll({ where: { messageId: newMessage.id }, include: ["endpoint"] });
  const sourceRows = linkRows.filter(
    row => row.endpoint?.platform === "fluxer" && row.endpoint?.channelId === newMessage.channelId
  );
  if (sourceRows.length === 0) {
    log("DEBUG", `FluxerUpdate skip id=${newMessage.id} reason=unbridgedMessage`);
    return;
  }

  const canUserPing = await checkPingPerms(newMessage.guildId, newMessage.author.id, newMessage.client);
  const canUserEmbed = newMessage.webhookId
    ? true
    : await checkEmbedPerms(newMessage.guildId, newMessage.channelId, newMessage.author.id, newMessage.client);

  let handledAny = false;

  for (const sourceRow of sourceRows) {
    const siblings = await findLinkSiblings(sourceRow.linkGroup);

    for (const other of siblings.filter(s => s.endpoint?.id !== sourceRow.endpointId)) {
      const targetEndpoint = other.endpoint;

      if (targetEndpoint.platform === "discord") {
        const nameIndicator = await resolveNameIndicator(targetEndpoint.guildId, newMessage.guildId);
        const webhook = await getDiscordWebhook(client, targetEndpoint);
        const everyonePings = await isBridgeToggleEnabled(targetEndpoint, "everyonePingEnabled");
        const canBridgePing = canUserPing && everyonePings;
        const otherSideGuild = await client.guilds.fetch(targetEndpoint.guildId);

        const replyHeader = refMessageId
          ? await replyLineFor(
              { channelId: targetEndpoint.channelId, guildId: targetEndpoint.guildId, platform: "discord", nameIndicator },
              refMessageId,
              refMessageForUpdate
            )
          : "";
        const editContent =
          replyHeader +
          (await traverseMessageLinks(
            await parseFluxerEmojiToDiscord(
              await resolveMentions(
                otherSideGuild,
                sanitizePings(await parseMentions(newMessage, null, otherSideGuild), canBridgePing)
              ),
              client,
              targetEndpoint.guildId,
              instanceId
            )
          ));

        const editDescs = (newMessage.attachments ?? [])
          .map(x => ({ url: x.proxyUrl ?? x.url ?? "", name: x.filename }))
          .filter(x => x.url);
        const editFiles = [];
        for (const a of editDescs) {
          const data = await downloadFluxerAttachment(a.url);
          if (!data) continue;
          editFiles.push({ attachment: data, name: a.name });
        }

        const attachments =
          editFiles.length > 0 ? await cloudUploadAttachments(client, targetEndpoint.channelId, editFiles) : undefined;

        const suppressEmbeds = newMessage.flags?.has?.(4) ?? false;

        if (!editContent && !attachments?.length && !suppressEmbeds) {
          log("DEBUG", `FluxerUpdate skip id=${newMessage.id} reason=emptyEdit`);
          continue;
        }

        const threadId = targetEndpoint.kind === "thread" ? targetEndpoint.channelId : null;

        log(
          "DEBUG",
          `FluxerUpdate bridged fluxerId=${newMessage.id} discordId=${other.messageId} endpoint=${targetEndpoint.id} fileCount=${editFiles.length} hasThread=${Boolean(threadId)}`
        );

        await webhook.editMessage(other.messageId, {
          content: editContent,
          attachments,
          ...(threadId ? { threadId } : {}),
          flags: suppressEmbeds || !canUserEmbed ? 4 : undefined,
          allowedMentions: { parse: [] },
        });
        handledAny = true;
        continue;
      }
      const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);
      const targetGuild = await fluxerClient.guilds.fetch(targetEndpoint.guildId).catch(() => null);
      if (!targetGuild) continue;

      const editContent = sanitizePings(
        await resolveMentions(targetGuild, await parseMentions(newMessage, newMessage.content, targetGuild, "fluxer")),
        true
      );

      const files = (newMessage.attachments ?? [])
        .filter(a => a.size <= MAX_ATTACHMENT_SIZE)
        .map(a => ({ url: a.proxyUrl ?? a.url, name: a.filename }));

      const payload = {
        content: editContent,
        embeds: newMessage.embeds ?? [],
        ...(files.length > 0 ? { files } : {}),
      };

      try {
        if (targetEndpoint.webhookId) {
          await editFluxerWebhook(targetEndpoint.webhookId, targetEndpoint.webhookToken, fluxerClient, other.messageId, payload, {
            threadId: targetEndpoint.kind === "thread" ? targetEndpoint.channelId : undefined,
          });
        } else {
          const channel = await fluxerClient.channels.fetch(targetEndpoint.channelId);
          await channel.messages.edit(other.messageId, payload);
        }
        handledAny = true;
      } catch (e) {
        log("FLUXER", `Failed to edit bridged fluxer message ${other.messageId} in channel ${targetEndpoint.channelId}`, e);
      }
    }
  }

  if (handledAny) resetBridgeHealth(newMessage.guildId);
}

/**
 * @param {{ id: string, channelId: string }} msg
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {FluxerCreateOptions} [options]
 */
export async function FluxerDeleteMessageHandler(msg, discordClient, fluxerClient, options = {}) {
  const instanceId = options.instanceId ?? "default";
  log("DEBUG", `FluxerDelete received messageId=${msg.id} channelId=${msg.channelId} instance=${instanceId}`);
  const rows = await MessageLink.findAll({
    where: { messageId: msg.id },
    include: ["endpoint"],
  });

  const sourceRows = rows.filter(row => row.endpoint?.platform === "fluxer" && row.endpoint?.channelId === msg.channelId);
  if (sourceRows.length === 0) {
    log("DEBUG", `FluxerDelete skip messageId=${msg.id} reason=unbridgedMessage`);
    return;
  }

  const linkGroups = [...new Set(sourceRows.map(row => row.linkGroup))];
  for (const linkGroup of linkGroups) {
    await deleteLogicalMessage(linkGroup, discordClient);
    await rewriteRepliesForDeleted(linkGroup, discordClient);
  }
  void fluxerClient;
}

/**
 * @param {{ channelId: string; ids: string[] }} msgs
 * @param {import("discord.js").Client} client
 * @param {FluxerCreateOptions} [options]
 */
export async function FluxerBulkDeleteMessageHandler(msgs, client, options = {}) {
  const instanceId = options.instanceId ?? "default";
  log("DEBUG", `FluxerBulkDelete received channelId=${msgs.channelId} count=${msgs.ids.length} instance=${instanceId}`);
  const rows = await MessageLink.findAll({
    where: { messageId: { [Op.in]: msgs.ids } },
    include: ["endpoint"],
  });

  const sourceRows = rows.filter(row => row.endpoint?.platform === "fluxer" && row.endpoint?.channelId === msgs.channelId);
  if (sourceRows.length === 0) {
    log("DEBUG", `FluxerBulkDelete skip channelId=${msgs.channelId} reason=unbridgedMessage`);
    return;
  }

  for (const row of sourceRows) {
    await deleteLogicalMessage(row.linkGroup, client);
  }
}

/**
 * @param {{ channelId: string }} chnl
 * @param {import("discord.js").Client} client
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {FluxerCreateOptions} [options]
 */
export async function FluxerPinsUpdateHandler(chnl, client, fluxerClient, options = {}) {
  const instanceId = options.instanceId ?? "default";
  log("DEBUG", `FluxerPinsUpdate received channelId=${chnl.channelId} instance=${instanceId}`);

  const endpoints = await findEndpoints("fluxer", chnl.channelId);
  const sourceKind = endpoints[0]?.kind ?? "channel";
  if (sourceKind === "thread") return;

  const sourceEndpoints = endpoints.filter(e => e.kind === "channel");
  if (sourceEndpoints.length === 0) return;

  const channel = await fluxerClient.channels.fetch(chnl.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const pinned = await channel.fetchPinnedMessages();
  const pinnedIds = pinned.map(x => x.id);

  const pinnedRows = await MessageLink.findAll({
    where: { messageId: { [Op.in]: pinnedIds } },
    include: ["endpoint"],
  });
  const ownPinnedGroups = new Set(
    pinnedRows.filter(r => r.endpoint?.platform === "fluxer" && r.endpoint?.channelId === chnl.channelId).map(r => r.linkGroup)
  );

  for (const entry of await collectTargets(sourceEndpoints, "fluxer", { kind: "channel", excludeChannelId: chnl.channelId })) {
    if (entry.endpoints[0].platform !== "discord") continue;
    const targetEndpoint = entry.endpoints[0];

    const discordChannel = await client.channels.fetch(targetEndpoint.channelId).catch(() => null);
    if (!discordChannel?.isTextBased()) continue;
    if (await resolveDiscordThreadChannel(client, targetEndpoint.channelId)) continue;

    const discordPinned = await discordChannel.messages.fetchPins();
    const discordPinnedIds = discordPinned.items.map(x => x.message.id);
    const localRows = await MessageLink.findAll({
      where: { linkGroup: [...ownPinnedGroups], endpointId: targetEndpoint.id },
    });

    for (const local of localRows) {
      if (!discordPinnedIds.includes(local.messageId)) {
        try {
          await discordChannel.messages.pin(local.messageId).catch(e => {
            if (e?.code !== 10003) throw e;
          });
        } catch {}
      }
    }

    const targetPinnedRows = await MessageLink.findAll({
      where: { messageId: { [Op.in]: discordPinnedIds }, endpointId: targetEndpoint.id },
    });
    for (const targetRow of targetPinnedRows) {
      const sourceCopy = await MessageLink.findOne({
        where: { linkGroup: targetRow.linkGroup, endpointId: sourceEndpoints[0].id },
      });
      if (sourceCopy && !pinnedIds.includes(sourceCopy.messageId)) {
        try {
          await discordChannel.messages.unpin(targetRow.messageId).catch(e => {
            if (e?.code !== 10003) throw e;
          });
        } catch {}
      }
    }
  }
}
