import { ChannelType, MessageFlags, MessageType } from "discord.js";
import { Routes as FluxerRoutes } from "@fluxerjs/core";
import { BridgeEndpoint, BridgeGroup, MessageLink } from "../db/index.js";
import Config from "../utils/ConfigHandler.js";
import { CommandHandler } from "./CommandHandler.js";
import { Op } from "sequelize";
import { readFileSync } from "node:fs";
import { discordEmbedToFluxer, isPlatformPreviewEmbed } from "./EmbedConverter.js";
import { parseDiscordEmojiToFluxer, traverseMessageLinks } from "./EmojiStickerParser.js";
import { attemptParseBridgedMessage, parseMentions } from "./MessageContentParser.js";
import { sanitizePings } from "./SanitizePings.js";
import { sendErrorMessage } from "./SendErrorMessage.js";
import { log } from "./Logger.js";
import { getGuildPrefix } from "./GetGuildPrefix.js";
import { sendFluxerWebhook, editFluxerWebhook } from "./FluxerWebhookSend.js";
import { processReplyContent } from "./ProcessReplyContent.js";
import { isDiscordSpoilerAttachment, SPOILER_ATTACHMENT_FLAG } from "./SpoilerAttachments.js";
import { checkEmbedPerms, checkPingPerms } from "./CheckManageServerPerms.js";
import { normalizeFcJson } from "./NormalizeJson.js";
import { getFluxerInstanceConfig } from "./ConfigHandler.js";
import { cacheUser, resolveMentions } from "./MentionResolver.js";
import { resetBridgeHealth } from "./BridgeHealth.js";
import { isBridgeToggleEnabled } from "./BridgeToggle.js";
import { processSticker } from "./StickerProcessor.js";
import { indicatorPrefix, resolveNameIndicator, withIndicator } from "./NameIndicator.js";
import { maybePublishFluxerMessage } from "./AnnouncementPublish.js";
import { autoBridgeDiscordThread, backfillMirroredThread, waitForPendingMirror } from "./ThreadMirror.js";
import { withFluxerRateLimit } from "./FluxerRateLimit.js";
import { canUserBridge, promptOptedOutUserOnFirstMessage } from "./UserOptOut.js";
import { waitForMessageMap } from "./WaitForMessageMap.js";
import { ensureLink, findEndpoints, findLinkSiblings, getRelay, newLinkGroup, recordRelay } from "./Bridging.js";
import { deleteLogicalMessage, rewriteRepliesForDeleted } from "./LogicalMessage.js";
import { resolveFluxerClient } from "./FluxerClients.js";
import { getDiscordWebhook } from "./Webhooks.js";
import { resolveDiscordThreadChannel } from "./DiscordThreadResolver.js";

/**
 * @typedef {Object} DiscordCreateOptions
 * @property {import("@fluxerjs/core").Client} [fluxerClient]
 * @property {boolean} [execCommands]
 */

let fluxcordBotEmojiCfg = undefined;

const MAX_ATTACHMENT_SIZE = 24999900;

const discordCdnAttachmentUrl = /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d+\/\d+\/[^\s<>()]+/g;

function staleDiscordCdnLink(url) {
  try {
    const ex = Number.parseInt(new URL(url).searchParams.get("ex") ?? "", 16);
    return !Number.isFinite(ex) || ex * 1000 <= Date.now() + 300000;
  } catch {
    return true;
  }
}

async function refreshDiscordCdnLinks(content, client, messageId) {
  const urls = [...new Set(content.match(discordCdnAttachmentUrl) ?? [])].filter(staleDiscordCdnLink);
  if (urls.length === 0) return content;

  let result = content;
  for (let i = 0; i < urls.length; i += 50) {
    try {
      const { refreshed_urls } = await client.rest.post("/attachments/refresh-urls", {
        body: { attachment_urls: urls.slice(i, i + 50) },
      });
      for (const { original, refreshed } of refreshed_urls ?? []) {
        if (original && refreshed)
          result = result.replaceAll(original, refreshed.replace("://media.discordapp.net/", "://cdn.discordapp.com/"));
      }
    } catch (e) {
      log("DISCORD", `Failed to refresh Discord CDN attachment links for message ${messageId}`, e);
    }
  }

  return result;
}

function fluxerReplyLine(instanceId) {
  const cfg = fluxcordBotEmojiCfg?.fluxerReplyEmoji;
  if (!cfg) return "-# <reply_l><reply_r> ";
  const entry = cfg[instanceId] ?? cfg.default ?? cfg;
  return `-# <${entry.replyL}><${entry.replyR}> `;
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

  /** @type {Map<string, { key: string, endpoints: any[], bridgeType: string }>} */
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
 * @param {any} target
 * @param {string | null} refMessageId source-local reply id
 * @param {any} refMessage resolved referenced message on the source platform
 * @returns {Promise<string>}
 */
async function replyLineFor(target, refMessageId, refMessage) {
  if (!refMessageId) return "";
  const local = await findReplyCopy(target.channelId, refMessageId);
  const isFluxerTarget = target.platform === "fluxer";
  const linePrefix = isFluxerTarget
    ? fluxerReplyLine(target.instanceId)
    : `-# <:reply_l:${fluxcordBotEmojiCfg.discordReplyEmoji.replyL}><:reply_r:${fluxcordBotEmojiCfg.discordReplyEmoji.replyR}> `;

  if (local) {
    const platform = local.endpoint?.platform;
    let authorLabel;
    if (platform === "discord") {
      authorLabel = `${indicatorPrefix("discord", target.nameIndicator)}@${refMessage?.author?.tag ?? "unknown-user"}`;
    } else {
      authorLabel = `${indicatorPrefix("fluxer", target.nameIndicator)}<@${local.authorId}>`;
    }
    const body = refMessage ? await processReplyContent(refMessage) : "*original message*";
    if (isFluxerTarget) {
      return `${linePrefix}${authorLabel}:\n`;
    }
    return `${linePrefix}${authorLabel}: [${body}](<https://discord.com/channels/${local.endpoint.guildId}/${local.endpoint.channelId}/${local.messageId}>)\n`;
  }

  if (refMessage) {
    const authorLabel = `${indicatorPrefix("discord", target.nameIndicator)}@${refMessage.author?.tag ?? "unknown-user"}`;
    const body = refMessage ? await processReplyContent(refMessage) : "*original message*";
    if (isFluxerTarget) {
      return `${linePrefix}${authorLabel}: ${body}\n`;
    }
    const url = `https://discord.com/channels/${target.guildId}/${target.channelId}/${refMessage.id}`;
    return `${linePrefix}${authorLabel}: [${body}](<${url}>)\n`;
  }

  return `${linePrefix}Unbridged message\n`;
}

/**
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Client} client
 */
async function resolveDiscordReference(message, client) {
  const reference = message.reference;
  if (!reference?.messageId || reference.type === 1) return null;

  if (reference.resolved && !reference.resolved.partial) return reference.resolved;

  try {
    const channel =
      reference.channelId && reference.channelId !== message.channelId
        ? await client.channels.fetch(reference.channelId)
        : message.channel;

    if (channel?.isTextBased?.() && channel.messages) {
      return await channel.messages.fetch(reference.messageId);
    }
  } catch {}

  return null;
}

function isDiscordUnknownMessageError(error) {
  return error?.code === 10008 || (error?.status === 404 && /unknown message/i.test(error?.message ?? ""));
}

function isFluxerUnknownMessageError(error) {
  return (
    error?.code === "MESSAGE_NOT_FOUND" ||
    error?.code === "UNKNOWN_MESSAGE" ||
    error?.status === 404 ||
    error?.statusCode === 404 ||
    error?.cause?.statusCode === 404
  );
}

async function deleteFluxerMessage(endpoint, messageId) {
  const fluxerClient = resolveFluxerClient(endpoint.instanceId);
  await withFluxerRateLimit(
    () => fluxerClient.rest.delete(FluxerRoutes.channelMessage(endpoint.channelId, messageId)),
    `channel:${endpoint.channelId}`
  );
}

async function deleteFluxerMessageIfExists(endpoint, messageId) {
  if (!messageId) return;

  try {
    await deleteFluxerMessage(endpoint, messageId);
  } catch (e) {
    if (!isFluxerUnknownMessageError(e)) throw e;
  }
}

const earlyBridgeEmojiThreshold = 3;

function countCustomEmojis(content) {
  if (!content) return 0;
  const matches = content.match(/<a?:.+?:\d+>/g);
  return matches ? matches.length : 0;
}

/**
 * @param {string} threadId
 * @param {string} parentId
 * @param {import("discord.js").Client} clientDiscord
 */
async function mirrorExistingThread(threadId, parentId, clientDiscord) {
  const parentEndpoints = await findEndpoints("discord", parentId);
  if (parentEndpoints.length === 0) return [];
  const thread = await clientDiscord.channels.fetch(threadId).catch(() => null);
  if (!thread || thread.type === ChannelType.PrivateThread) return [];
  const rows = await autoBridgeDiscordThread(thread, parentEndpoints, clientDiscord);
  if (!rows.length) return [];
  log("DEBUG", `DiscordCreate mirrored on activity thread ${thread.id}`);
  await backfillMirroredThread(
    thread,
    async message => await DiscordCreateMessageHandler(message, clientDiscord, { execCommands: false })
  );
  return rows;
}

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean>>} message
 * @param {import("discord.js").Client} client
 * @param {DiscordCreateOptions} [options]
 */
export async function DiscordCreateMessageHandler(message, client, options = {}) {
  log(
    "DEBUG",
    `DiscordCreate received id=${message.id} channelId=${message.channelId} guildId=${message.guildId} authorId=${message.author?.id} type=${message.type} hasReference=${Boolean(message.reference)}`
  );
  cacheUser(message.author, "discord");

  if (!fluxcordBotEmojiCfg) {
    fluxcordBotEmojiCfg = normalizeFcJson(JSON.parse(readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8")));
  }

  if (
    !message.guildId ||
    message.type === MessageType.ChannelNameChange ||
    message.type === MessageType.ChannelIconChange ||
    message.type === MessageType.ChannelPinnedMessage ||
    message.type === MessageType.ThreadCreated ||
    message.type === MessageType.ThreadStarterMessage
  ) {
    log("DEBUG", `DiscordCreate skip id=${message.id} reason=unsupportedGuildOrType type=${message.type}`);
    return;
  }

  const initialMessage = message.content;

  const guildPrefix = await getGuildPrefix(message.guildId);
  if (message.content.startsWith(guildPrefix)) {
    log("DEBUG", `DiscordCreate id=${message.id} isCommand=${options.execCommands !== false}`);
    if (options.execCommands === false) return;
    await CommandHandler(message, client, options.fluxerClient);
    return;
  }

  const isLoadingInteraction = message.type === MessageType.ChatInputCommand && message.flags.has("Loading");

  if (isLoadingInteraction) {
    log("DEBUG", `DiscordCreate defer id=${message.id} reason=loadingInteraction`);
    setTimeout(async () => {
      try {
        await DiscordCreateMessageHandler(message, client, options);
      } catch (e) {
        await sendErrorMessage(message, client, e);
      }
    }, 5000);
    return;
  }

  let endpoints = await findEndpoints("discord", message.channelId);

  if (endpoints.length === 0) {
    const known = message.channel;
    const thread = known?.isThread?.()
      ? known
      : !known || known.partial
        ? await client.channels.fetch(message.channelId).catch(() => null)
        : null;
    if (thread?.isThread?.()) {
      const pending = await waitForPendingMirror("discord", message.channelId);
      if (pending?.length) {
        endpoints = pending;
        log("DEBUG", `DiscordCreate id=${message.id} resolved pending mirror for thread ${message.channelId}`);
      } else if (thread.parentId) {
        const rows = await mirrorExistingThread(message.channelId, thread.parentId, client);
        if (rows.length) return;
        endpoints = await findEndpoints("discord", message.channelId);
        if (endpoints.length === 0) {
          log("DEBUG", `DiscordCreate skip id=${message.id} channelId=${message.channelId} reason=unbridgedThread`);
          return;
        }
      }
    }
  }

  if (endpoints.length === 0) {
    log("DEBUG", `DiscordCreate skip id=${message.id} channelId=${message.channelId} reason=noEndpoints`);
    return;
  }

  const relayWebhookId = message.webhookId ?? null;
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
    log("DEBUG", `DiscordCreate skip id=${message.id} authorId=${message.author.id} reason=webhookEcho`);
    return;
  }

  if (relay) {
    await propagateRelayEcho(message, relayEndpoint, relay, client);
    return;
  }

  if (!(await canUserBridge("discord", message.author.id, message.guildId))) {
    await promptOptedOutUserOnFirstMessage(message.guildId, "discord", message.author, message.guild.name);
    log("DEBUG", `DiscordCreate skip id=${message.id} authorId=${message.author.id} reason=userOptOut`);
    return;
  }

  const kind = endpoints.some(e => e.kind === "thread") ? "thread" : "channel";

  const isCrosspostCopy = message.flags.has(MessageFlags.IsCrosspost);

  let forwardedMessage = null;
  if (message.reference?.type === 1 && message.type !== MessageType.UserJoin && !isCrosspostCopy) {
    forwardedMessage = message.messageSnapshots?.first?.() ?? message.messageSnapshots?.[0];
  }

  const bridgeContent = await attemptParseBridgedMessage(message);

  const refMessageIdCandidates = [];
  if (!isCrosspostCopy) {
    if (message.reference?.messageId && message.reference.type !== 1) refMessageIdCandidates.push(message.reference.messageId);
    if (bridgeContent.isBridge || bridgeContent.isProxy) {
      if (bridgeContent.messageData?.messageId) refMessageIdCandidates.push(bridgeContent.messageData.messageId);
    }
  }

  let forwardedRefMessage = null;
  const refMessageId = refMessageIdCandidates[0] ?? null;

  let refMessage = null;
  if (refMessageId) {
    refMessage = await resolveDiscordReference(message, client);
    await waitForMessageMap("discord", refMessageId, refMessage?.author?.id, refMessage?.createdAt, message.guildId);
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

  const targets = await collectTargets(endpoints, "discord", { kind, excludeChannelId: message.channelId });

  let sentAny = false;

  for (const entry of targets) {
    let sent = null;
    if (entry.endpoints[0].platform === "fluxer") {
      sent = await sendToFluxerTarget(
        message,
        forwardedMessage,
        forwardedRefMessage,
        refMessageId,
        refMessage,
        bridgeContent,
        entry,
        linkGroup,
        client
      );
    } else {
      sent = await sendToDiscordTarget(
        message,
        forwardedMessage,
        refMessageId,
        refMessage,
        bridgeContent,
        entry,
        linkGroup,
        client
      );
    }
    if (sent) sentAny = true;
  }

  if (sentAny) resetBridgeHealth(message.guildId);

  const checkMsg = async () => {
    try {
      const channel = await message.channel.fetch();
      if (channel.isSendable()) {
        const fetchedMsg = await channel.messages.fetch(message.id);
        if (fetchedMsg.content !== initialMessage || fetchedMsg.editedAt) {
          await DiscordUpdateMessageHandler(fetchedMsg, fetchedMsg, options.fluxerClient);
        }
      }
    } catch (e) {
      if (isDiscordUnknownMessageError(e)) {
        await deleteLogicalMessage(linkGroup, client);
        return;
      }

      log("DISCORD", "Could not verify source Discord message before mapping bridged Fluxer message", e);
    }
  };
  setTimeout(checkMsg, 1000);
  setTimeout(checkMsg, 2500);
  setTimeout(checkMsg, 5000);
}

/**
 * @param {import("discord.js").Message} message
 * @param {any} forwardedMessage
 * @param {any} forwardedRefMessage
 * @param {string | null} refMessageId
 * @param {any} refMessage
 * @param {any} bridgeContent
 * @param {{ endpoints: any[] }} entry
 * @param {string} linkGroup
 * @param {import("discord.js").Client} client
 * @param {number | null} [sourceGroupId]
 * @returns {Promise<any | null>}
 */
async function sendToFluxerTarget(
  message,
  forwardedMessage,
  forwardedRefMessage,
  refMessageId,
  refMessage,
  bridgeContent,
  entry,
  linkGroup,
  client,
  sourceGroupId = null
) {
  const targetEndpoint = entry.endpoints.find(e => e.webhookId) ?? entry.endpoints[0];

  let delivered = true;
  for (const endpoint of entry.endpoints) {
    const existing = await ensureLink(linkGroup, endpoint.id, message.id, refMessageId, message.author?.id);
    if (existing && endpoint.id === targetEndpoint.id) delivered = false;
  }
  if (!delivered) {
    log("DEBUG", `DiscordCreate skip target endpoint=${targetEndpoint.id} message=${message.id} reason=alreadyLinked`);
    return null;
  }

  const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);
  const instanceId = targetEndpoint.instanceId;

  let nameIndicator = undefined;
  try {
    nameIndicator = await resolveNameIndicator(targetEndpoint.guildId, message.guildId);
  } catch {}

  const source = forwardedMessage ?? message;

  const webhookFiles = source.attachments
    .filter(a => a.size <= MAX_ATTACHMENT_SIZE)
    .map(a => ({
      name: a.name,
      url: a.url ?? a.proxyURL,
      flags: isDiscordSpoilerAttachment(a) ? SPOILER_ATTACHMENT_FLAG : undefined,
      description: a.description,
    }));

  const overAttachments = source.attachments.filter(a => a.size > MAX_ATTACHMENT_SIZE);
  const overAttachmentsStr = overAttachments.map(a => `[${a.name}](<${a.url ?? a.proxyURL}>)`).join(" ");

  const stickerFiles = [];
  const stickerFallbacks = [];
  let stickerMsg = "";

  for (const sticker of (forwardedMessage ?? message).stickers?.values?.() ?? []) {
    if (sticker.url?.endsWith("json")) continue;

    const stickerUrl = sticker.url;
    const isAnimated = stickerUrl.endsWith(".gif") || sticker.format === 2;
    const processed = await processSticker(stickerUrl, {
      animated: isAnimated,
      name: sticker.name,
    });

    if (processed) {
      stickerFiles.push({ name: processed.filename, data: processed.buffer });
    } else {
      stickerFallbacks.push(`[${sticker.name}](${stickerUrl})`);
    }
  }
  if (stickerFallbacks.length > 0) stickerMsg = stickerFallbacks.join(", ");

  const interactingUser = message.interaction ? message.interactionMetadata?.user : undefined;
  let userJoin = "";
  if (message.type === MessageType.UserJoin) {
    let prefix = "";
    try {
      prefix = indicatorPrefix("discord", nameIndicator);
    } catch {}
    userJoin = `*${prefix}@${message.author.tag} joined the bridged community*`;
  }

  const webhookFilesWithStickers = webhookFiles.concat(stickerFiles);

  const fastUsername = withIndicator(
    message.author.displayName ?? message.author.globalName ?? "Fluxcord",
    "discord",
    nameIndicator
  );

  if (!targetEndpoint.webhookId) {
    log("DEBUG", `DiscordCreate skip target endpoint=${targetEndpoint.id} reason=noFluxerWebhook`);
    return null;
  }

  const canUserEmbed = message.webhookId
    ? true
    : await checkEmbedPerms(message.guildId, message.channelId, message.author.id, client);

  const canUserPing = await checkPingPerms(message.guildId, message.author.id, client);
  const everyonePings = await isBridgeToggleEnabled(targetEndpoint, "everyonePingEnabled");
  const canBridgePing = canUserPing && everyonePings;

  const otherSideGuild = await withFluxerRateLimit(
    () => fluxerClient.guilds.fetch(targetEndpoint.guildId),
    `guild:${targetEndpoint.guildId}`
  ).catch(() => null);
  if (!otherSideGuild) {
    log("FLUXER", `Failed to fetch fluxer guild for endpoint ${targetEndpoint.id} (guild ${targetEndpoint.guildId})`);
    return null;
  }

  const webhookFlags = (message.flags.has(MessageFlags.SuppressNotifications) ? 4096 : 0) | (canUserEmbed ? 0 : 4);
  const webhookAllowedMentions = forwardedMessage
    ? { parse: [] }
    : {
        parse: ["users", "roles", ...(canBridgePing ? ["everyone"] : [])],
        replied_user: true,
      };

  let parsedContent = await traverseMessageLinks(
    await parseDiscordEmojiToFluxer(
      await resolveMentions(
        otherSideGuild,
        sanitizePings(
          await parseMentions(source, bridgeContent.messageData.parsedContent, otherSideGuild),
          canBridgePing && !forwardedMessage
        )
      ),
      fluxerClient,
      targetEndpoint.guildId,
      getFluxerInstanceConfig(instanceId)?.FluxerTempEmojiGuildId
    )
  );
  parsedContent = await refreshDiscordCdnLinks(parsedContent, client, message.id);

  let followNotice = parsedContent;
  if (message.type === MessageType.ChannelFollowAdd) {
    let prefix = "";
    try {
      prefix = indicatorPrefix("discord", nameIndicator);
    } catch {}
    followNotice = `**${prefix}@${message.author.tag}** followed **${parsedContent}** into this channel. Messages published there will appear here.`;
  }

  let replyLineText = "";
  let messageReferenceOption;
  const refForHeader = refMessageId ?? null;
  if (refForHeader && !forwardedMessage) {
    replyLineText = await replyLineFor(
      { channelId: targetEndpoint.channelId, guildId: targetEndpoint.guildId, platform: "fluxer", instanceId, nameIndicator },
      refForHeader,
      refMessage
    );
    const localReply = await findReplyCopy(targetEndpoint.channelId, refForHeader);
    if (localReply && localReply.endpoint?.platform === "fluxer") {
      messageReferenceOption = { message_id: localReply.messageId };
    }
  }

  let webhookContent =
    (forwardedMessage ? `${fluxerReplyLine(instanceId)}Forwarded\n` : "") +
    (interactingUser
      ? `${fluxerReplyLine(instanceId)} ${indicatorPrefix("discord", nameIndicator)}@${interactingUser.tag} used \`/${message.interaction?.commandName}\`\n`
      : "") +
    (message.flags.has(MessageFlags.IsComponentsV2) ? "*Components V2 message*\n" : "") +
    followNotice +
    stickerMsg +
    userJoin +
    (overAttachmentsStr ? "\n-# has attachments over 25mb: " + overAttachmentsStr : "");

  const wEmbeds = source.embeds ?? [];
  const filteredEmbeds = typeof bridgeContent.excludeEmbed === "number" ? [...wEmbeds] : wEmbeds;
  if (typeof bridgeContent.excludeEmbed === "number") filteredEmbeds.splice(bridgeContent.excludeEmbed, 1);
  const sourceContent = source.content ?? "";
  const webhookEmbeds = await Promise.all(
    filteredEmbeds
      .filter(x => !isPlatformPreviewEmbed(x, sourceContent))
      .map(async x => await discordEmbedToFluxer(x, fluxerClient))
  );

  if (!webhookContent.trim() && webhookFilesWithStickers.length === 0 && webhookEmbeds.length === 0) {
    log("WARN", `[DiscordHandler] Webhook content is empty for message ${message.id}.`);
    webhookContent = message.poll ? "-# Sent a poll" : "-# Sent an unsupported sticker or empty message";
  }

  const webhookUsername = fastUsername;

  let sent;
  try {
    sent = await sendFluxerWebhook(targetEndpoint.webhookId, targetEndpoint.webhookToken, fluxerClient, {
      content: webhookContent,
      username: webhookUsername,
      avatar_url: message.author.avatarURL() ?? undefined,
      embeds: webhookEmbeds,
      files: webhookFilesWithStickers,
      message_reference: messageReferenceOption,
      allowed_mentions: webhookAllowedMentions,
      flags: webhookFlags,
      ...(targetEndpoint.kind === "thread" ? { threadId: targetEndpoint.channelId } : {}),
    });
  } catch (e) {
    log("FLUXER", `Failed to bridge Discord message ${message.id}`, e);
    return null;
  }

  recordRelay(targetEndpoint.id, targetEndpoint.webhookId, linkGroup, sourceGroupId);

  try {
    await maybePublishFluxerMessage(fluxerClient, targetEndpoint, sent?.id);
  } catch {}

  log(
    "DEBUG",
    `DiscordCreate bridged discordId=${message.id} fluxerId=${sent?.id} instance=${instanceId} endpoint=${targetEndpoint.id} fileCount=${webhookFilesWithStickers.length} embedCount=${webhookEmbeds.length}`
  );
  return sent;
}

/**
 * @param {import("discord.js").Message} message
 * @param {any} forwardedMessage
 * @param {string | null} refMessageId
 * @param {any} refMessage
 * @param {any} bridgeContent
 * @param {{ endpoints: any[] }} entry
 * @param {string} linkGroup
 * @param {import("discord.js").Client} client
 * @param {number | null} [sourceGroupId]
 * @returns {Promise<any | null>}
 */
async function sendToDiscordTarget(
  message,
  forwardedMessage,
  refMessageId,
  refMessage,
  bridgeContent,
  entry,
  linkGroup,
  client,
  sourceGroupId = null
) {
  const targetEndpoint = entry.endpoints[0];
  if (!targetEndpoint.webhookId) {
    log("DEBUG", `DiscordCreate skip target endpoint=${targetEndpoint.id} reason=noDiscordWebhook`);
    return null;
  }

  let delivered = true;
  for (const endpoint of entry.endpoints) {
    const existing = await ensureLink(linkGroup, endpoint.id, message.id, refMessageId, message.author?.id);
    if (existing && endpoint.id === targetEndpoint.id) delivered = false;
  }
  if (!delivered) {
    log(
      "DEBUG",
      `DiscordCreate skip same-platform target endpoint=${targetEndpoint.id} message=${message.id} reason=alreadyLinked`
    );
    return null;
  }

  let nameIndicator = undefined;
  try {
    nameIndicator = await resolveNameIndicator(targetEndpoint.guildId, message.guildId);
  } catch {}

  const source = forwardedMessage ?? message;

  const targetGuild = await client.guilds.fetch(targetEndpoint.guildId).catch(() => null);
  if (!targetGuild) {
    log("DISCORD", `Failed to fetch discord guild for endpoint ${targetEndpoint.id} (guild ${targetEndpoint.guildId})`);
    return null;
  }

  let parsedContent = source.content ?? "";
  try {
    parsedContent = await resolveMentions(
      targetGuild,
      sanitizePings(await parseMentions(source, bridgeContent.messageData?.parsedContent ?? null, targetGuild), true)
    );
  } catch (e) {
    log("DISCORD", `Failed to convert content for same-platform target of message ${message.id}`, e);
  }
  parsedContent = await refreshDiscordCdnLinks(parsedContent, client, message.id);

  const canUserPing = await checkPingPerms(message.guildId, message.author.id, client);
  const everyonePings = await isBridgeToggleEnabled(targetEndpoint, "everyonePingEnabled");
  const canBridgePing = canUserPing && everyonePings;

  let userJoin = "";
  if (message.type === MessageType.UserJoin) {
    userJoin = `*${indicatorPrefix("discord", nameIndicator)}@${message.author.tag} joined the bridged community*`;
  }

  let followNotice = parsedContent;
  if (message.type === MessageType.ChannelFollowAdd) {
    followNotice = `**${indicatorPrefix("discord", nameIndicator)}@${message.author.tag}** followed **${parsedContent}** into this channel. Messages published there will appear here.`;
  }

  let stickerMsg = "";
  const stickerFiles = [];
  for (const sticker of source.stickers?.values?.() ?? []) {
    if (sticker.url?.endsWith("json")) continue;
    const processed = await processSticker(sticker.url, { animated: sticker.format === 2, name: sticker.name });
    if (processed) {
      stickerFiles.push({ attachment: processed.buffer, name: processed.filename });
    } else {
      stickerMsg += (stickerMsg ? ", " : "") + `[${sticker.name}](${sticker.url})`;
    }
  }

  const webhookFiles = source.attachments
    .filter(a => a.size <= MAX_ATTACHMENT_SIZE)
    .map(a => ({
      attachment: a.proxyURL ?? a.url,
      name: a.name,
      description: a.description,
    }));
  const files = webhookFiles.concat(stickerFiles).map(a => ({
    attachment: a.attachment ?? a.url,
    name: a.name,
  }));

  const overAttachments = source.attachments.filter(a => a.size > MAX_ATTACHMENT_SIZE);
  const overAttachmentsStr = overAttachments.map(a => `[${a.name}](<${a.url ?? a.proxyURL}>)`).join(" ");

  const replyHeader =
    refMessageId && !forwardedMessage
      ? await replyLineFor(
          {
            channelId: targetEndpoint.channelId,
            guildId: targetEndpoint.guildId,
            platform: "discord",
            nameIndicator: nameIndicator,
          },
          refMessageId,
          refMessage
        )
      : "";

  const webhook = await getDiscordWebhook(client, targetEndpoint);

  let threadId = null;
  if (targetEndpoint.kind === "thread") {
    threadId = targetEndpoint.channelId;
  } else {
    const discordThread = await resolveDiscordThreadChannel(client, targetEndpoint.channelId).catch(() => null);
    if (discordThread?.archived && !discordThread.locked) {
      try {
        await discordThread.setArchived(false);
      } catch (e) {
        log("DISCORD", `Failed to unarchive bridged Discord thread ${discordThread.id}`, e);
      }
    }
    threadId = discordThread?.id ?? null;
  }

  const webhookEmbeds = source.embeds ?? [];
  const wEmbedsList = typeof bridgeContent.excludeEmbed === "number" ? [...webhookEmbeds] : webhookEmbeds;
  if (typeof bridgeContent.excludeEmbed === "number") wEmbedsList.splice(bridgeContent.excludeEmbed, 1);

  const webhookAllowedMentions = forwardedMessage
    ? { parse: [] }
    : {
        parse: ["users", "roles", ...(canBridgePing ? ["everyone"] : [])],
        replied_user: false,
      };

  let content =
    (forwardedMessage
      ? `-# <:reply_l:${fluxcordBotEmojiCfg.discordReplyEmoji.replyL}><:reply_r:${fluxcordBotEmojiCfg.discordReplyEmoji.replyR}> Forwarded message\n`
      : "") +
    replyHeader +
    followNotice +
    userJoin +
    stickerMsg +
    (overAttachmentsStr ? "\n-# has attachments over 25mb: " + overAttachmentsStr : "");

  if (!content.trim() && files.length === 0 && wEmbedsList.length === 0) {
    content = "-# Sent an unsupported message";
  }

  let sent;
  try {
    sent = await webhook.send({
      content,
      embeds: wEmbedsList,
      username: withIndicator(message.author.displayName ?? message.author.globalName ?? "Fluxcord", "discord", nameIndicator),
      avatarURL: message.author.avatarURL() ?? undefined,
      files,
      allowedMentions: webhookAllowedMentions,
      flags:
        (message.flags.has(MessageFlags.SuppressNotifications) ? 4096 : 0) |
        (message.webhookId ? (message.flags.has(MessageFlags.SuppressEmbeds) ? 4 : 0) : 4),
      ...(threadId ? { threadId } : {}),
    });
  } catch (e) {
    log("DISCORD", `Failed to send message into Discord channel ${targetEndpoint.channelId}`, e);
    return null;
  }

  recordRelay(targetEndpoint.id, targetEndpoint.webhookId, linkGroup, sourceGroupId);

  log(
    "DEBUG",
    `DiscordCreate bridged discordId=${message.id} discordTargetId=${sent?.id} endpoint=${targetEndpoint.id} fileCount=${files.length}`
  );
  return sent;
}

/**
 * @param {import("discord.js").Message} message
 * @param {any} relayEndpoint
 * @param {{ linkGroup: string, sourceGroupId: number }} relay
 * @param {import("@fluxerjs/core").Client} [fluxerClientDefault]
 */
async function propagateRelayEcho(message, relayEndpoint, relay, discordClient) {
  const linkGroup = relay.linkGroup;
  const sourceGroupId = relay.sourceGroupId;

  const channelEndpoints = await BridgeEndpoint.findAll({
    where: { platform: "discord", channelId: relayEndpoint.channelId },
    raw: true,
  });
  if (channelEndpoints.length === 0) return;

  const linkedRows = await MessageLink.findAll({ where: { linkGroup }, attributes: ["endpointId"], raw: true });
  const linkedEndpointIds = new Set(linkedRows.map(l => l.endpointId));
  const linkedGroupIds = [...new Set(channelEndpoints.filter(e => linkedEndpointIds.has(e.id)).map(e => e.groupId))];

  const targets = await collectTargets(channelEndpoints, "discord", {
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
      .map(a => ({ url: a.proxyURL ?? a.url, name: a.name }));

    if (entry.endpoints[0].platform === "fluxer") {
      const endpoint = entry.endpoints.find(e => e.webhookId) ?? entry.endpoints[0];
      const fluxerClient = resolveFluxerClient(endpoint.instanceId);
      try {
        await sendFluxerWebhook(endpoint.webhookId, endpoint.webhookToken, fluxerClient, {
          content: message.content,
          embeds: message.embeds ?? [],
          ...(attachmentFiles.length > 0 ? { files: attachmentFiles } : {}),
          allowed_mentions: { parse: [] },
          ...(endpoint.kind === "thread" ? { threadId: endpoint.channelId } : {}),
        });
      } catch (e) {
        log("FLUXER", `Failed to relay message to ${endpoint.channelId}`, e);
      }
      recordRelay(endpoint.id, endpoint.webhookId, linkGroup, sourceGroupId);
    } else {
      const endpoint = entry.endpoints[0];
      const webhook = await getDiscordWebhook(discordClient, endpoint);
      try {
        await webhook.send({
          content: message.content,
          embeds: message.embeds ?? [],
          ...(attachmentFiles.length > 0 ? { files: attachmentFiles.map(a => ({ attachment: a.url, name: a.name })) } : {}),
        });
      } catch (e) {
        log("DISCORD", `Failed to relay message to ${endpoint.channelId}`, e);
      }
      recordRelay(endpoint.id, endpoint.webhookId, linkGroup, sourceGroupId);
    }
  }
}

/**
 * @param {import("discord.js").Message} oldMsg
 * @param {import("discord.js").Message} newMsg
 * @param {import("@fluxerjs/core").Client} [fluxerClientDefault]
 */
export async function DiscordUpdateMessageHandler(oldMsg, newMsg, fluxerClientDefault) {
  const authorId = newMsg.author?.id ?? oldMsg.author?.id ?? "";
  log(
    "DEBUG",
    `DiscordUpdate received id=${newMsg.id} channelId=${newMsg.channelId ?? oldMsg.channelId} guildId=${newMsg.guildId ?? oldMsg.guildId} authorId=${authorId}`
  );

  if (newMsg.thread && !(oldMsg && !oldMsg.partial && oldMsg.thread)) {
    log("DEBUG", `DiscordUpdate skip id=${newMsg.id} reason=threadCreated`);
    return;
  }

  if (newMsg.type === MessageType.PollResult) {
    log("DEBUG", `DiscordUpdate skip id=${newMsg.id} reason=pollResult`);
    return;
  }

  if (!(await canUserBridge("discord", authorId, newMsg.guildId ?? oldMsg.guildId))) return;

  if (newMsg.webhookId) {
    const echoRow = await BridgeEndpoint.findOne({
      where: { platform: "discord", channelId: newMsg.channelId, webhookId: newMsg.webhookId },
      raw: true,
    });
    if (echoRow) {
      log("DEBUG", `DiscordUpdate skip id=${newMsg.id} reason=webhookEcho`);
      return;
    }
  }

  const linkRows = await MessageLink.findAll({ where: { messageId: newMsg.id }, include: ["endpoint"] });
  const sourceRows = linkRows.filter(row => row.endpoint?.platform === "discord" && row.endpoint?.channelId === newMsg.channelId);
  if (sourceRows.length === 0) {
    log("DEBUG", `DiscordUpdate skip id=${newMsg.id} reason=unbridgedMessage`);
    return;
  }

  const canUserPing = await checkPingPerms(newMsg.guildId, newMsg.author.id, newMsg.client);
  const canUserEmbed = newMsg.webhookId
    ? true
    : await checkEmbedPerms(newMsg.guildId, newMsg.channelId, newMsg.author.id, newMsg.client);

  const isCrosspostCopy = newMsg.flags.has(MessageFlags.IsCrosspost);
  const bridgeContent = await attemptParseBridgedMessage(newMsg);

  let refMessageForUpdate = null;
  const refMessageId = !isCrosspostCopy && newMsg.reference?.type !== 1 ? (newMsg.reference?.messageId ?? null) : null;
  if (refMessageId) refMessageForUpdate = await resolveDiscordReference(newMsg, newMsg.client);

  let handledAny = false;

  for (const sourceRow of sourceRows) {
    const siblings = await findLinkSiblings(sourceRow.linkGroup);

    for (const other of siblings.filter(s => s.endpoint?.id !== sourceRow.endpointId)) {
      const targetEndpoint = other.endpoint;

      if (targetEndpoint.platform === "fluxer") {
        const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);
        const instanceId = targetEndpoint.instanceId;
        const everyonePings = await isBridgeToggleEnabled(targetEndpoint, "everyonePingEnabled");
        const canBridgePing = canUserPing && everyonePings;
        const otherSideGuild = await fluxerClient.guilds.fetch(targetEndpoint.guildId).catch(() => null);
        if (!otherSideGuild) continue;

        let newContent =
          (await replyLineFor(
            {
              channelId: targetEndpoint.channelId,
              guildId: targetEndpoint.guildId,
              platform: "fluxer",
              instanceId,
              nameIndicator: undefined,
            },
            refMessageId,
            refMessageForUpdate
          )) +
          (await traverseMessageLinks(
            await parseDiscordEmojiToFluxer(
              await resolveMentions(
                otherSideGuild,
                sanitizePings(await parseMentions(newMsg, bridgeContent.messageData.parsedContent, otherSideGuild), canBridgePing)
              ),
              fluxerClient,
              targetEndpoint.guildId
            )
          ));

        newContent = await refreshDiscordCdnLinks(newContent, newMsg.client, newMsg.id);

        const newEmbeds = await Promise.all(
          (newMsg.embeds ?? [])
            .filter(x => !isPlatformPreviewEmbed(x, newMsg.content ?? ""))
            .map(async x => await discordEmbedToFluxer(x, fluxerClient))
        );

        const suppressEmbeds = newMsg.flags?.has?.(MessageFlags.SuppressEmbeds) ?? false;
        const suppressNotifications = newMsg.flags?.has?.(MessageFlags.SuppressNotifications) ?? false;

        const files = (newMsg.attachments ?? [])
          .filter(a => a.size <= MAX_ATTACHMENT_SIZE)
          .map(a => ({ name: a.name, url: a.proxyURL ?? a.url }));

        if (!newContent && newEmbeds.length === 0 && !suppressEmbeds && files.length === 0) {
          log("DEBUG", `DiscordUpdate skip id=${newMsg.id} reason=emptyEdit`);
          continue;
        }

        log(
          "DEBUG",
          `DiscordUpdate bridged discordId=${newMsg.id} fluxerId=${other.messageId} instance=${instanceId} endpoint=${targetEndpoint.id} embedCount=${newEmbeds.length}`
        );

        try {
          const current = await withFluxerRateLimit(
            () => fluxerClient.rest.get(FluxerRoutes.channelMessage(targetEndpoint.channelId, other.messageId)),
            `channel:${targetEndpoint.channelId}`
          );
          const currentFlags = current?.flags ?? 0;
          const nextFlags =
            (suppressEmbeds || !canUserEmbed ? currentFlags | 4 : currentFlags & ~4) | (suppressNotifications ? 4096 : 0);

          if (targetEndpoint.webhookId) {
            await editFluxerWebhook(targetEndpoint.webhookId, targetEndpoint.webhookToken, fluxerClient, other.messageId, {
              content: newContent,
              embeds: newEmbeds,
              flags: nextFlags,
            });
          } else {
            await withFluxerRateLimit(
              () =>
                fluxerClient.rest.patch(FluxerRoutes.channelMessage(targetEndpoint.channelId, other.messageId), {
                  body: {
                    content: newContent,
                    embeds: newEmbeds,
                    flags: nextFlags,
                  },
                }),
              `channel:${targetEndpoint.channelId}`
            );
          }
          handledAny = true;
        } catch (e) {
          log("FLUXER", `Failed to edit bridged fluxer message ${other.messageId} in channel ${targetEndpoint.channelId}`, e);
        }
        continue;
      }

      const targetGuild = await newMsg.client.guilds.fetch(targetEndpoint.guildId).catch(() => null);
      if (!targetGuild) continue;

      let newContent = bridgeContent.messageData?.parsedContent ?? newMsg.content ?? "";
      try {
        newContent = await resolveMentions(
          targetGuild,
          sanitizePings(await parseMentions(newMsg, bridgeContent.messageData?.parsedContent ?? null, targetGuild), true)
        );
      } catch (e) {
        log("DISCORD", `Failed to convert content for same-platform target of message ${newMsg.id}`, e);
      }
      newContent = await refreshDiscordCdnLinks(newContent, newMsg.client, newMsg.id);

      const files = (newMsg.attachments ?? [])
        .filter(a => a.size <= MAX_ATTACHMENT_SIZE)
        .map(a => ({ attachment: a.proxyURL ?? a.url, name: a.name }));

      const newEmbeds = (newMsg.embeds ?? []).filter(x => !isPlatformPreviewEmbed(x, newMsg.content ?? ""));

      const suppressEmbeds = newMsg.flags?.has?.(MessageFlags.SuppressEmbeds) ?? false;

      const payload = {
        content: newContent,
        embeds: newEmbeds,
        files,
        allowedMentions: { parse: [] },
      };

      try {
        if (targetEndpoint.webhookId) {
          const webhook = await getDiscordWebhook(newMsg.client, targetEndpoint);
          await webhook.editMessage(other.messageId, {
            content: payload.content,
            embeds: payload.embeds,
            attachments: payload.files.map(a => ({ attachment: a.attachment, name: a.name })),
            allowedMentions: payload.allowedMentions,
            ...(targetEndpoint.kind === "thread" ? { threadId: targetEndpoint.channelId } : {}),
          });
        } else {
          const channel = await newMsg.client.channels.fetch(targetEndpoint.channelId);
          await /** @type {import("discord.js").TextChannel} */ (channel).messages.edit(other.messageId, payload);
        }
        handledAny = true;
      } catch (e) {
        log("DISCORD", `Failed to edit bridged discord message ${other.messageId} in channel ${targetEndpoint.channelId}`, e);
      }
    }
  }

  if (handledAny) resetBridgeHealth(newMsg.guildId ?? oldMsg.guildId);
}

/**
 * @param {import("discord.js").PartialMessage} msg
 * @param {import("discord.js").Client} client
 */
export async function DiscordDeleteMessageHandler(msg, client) {
  log("DEBUG", `DiscordDelete received id=${msg.id} channelId=${msg.channelId}`);
  const rows = await MessageLink.findAll({ where: { messageId: msg.id }, include: ["endpoint"] });
  const sourceRows = rows.filter(row => row.endpoint?.platform === "discord" && row.endpoint?.channelId === msg.channelId);

  if (sourceRows.length > 0) {
    for (const row of sourceRows) {
      await deleteLogicalMessage(row.linkGroup, client);
      await rewriteRepliesForDeleted(row.linkGroup, client);
    }
    return;
  }

  log("DEBUG", `DiscordDelete skip id=${msg.id} reason=unbridgedMessage`);
}

/**
 * @param {import("discord.js").Collection<string, import("discord.js").PartialMessage>} msgs
 * @param {import("discord.js").Client} client
 */
export async function DiscordBulkDeleteMessageHandler(msgs, client) {
  log("DEBUG", `DiscordBulkDelete received count=${msgs.size}`);
  const ids = [...msgs.keys()];
  const rows = await MessageLink.findAll({
    where: { messageId: { [Op.in]: ids } },
    include: ["endpoint"],
  });

  const sourceRows = rows.filter(
    row =>
      row.endpoint?.platform === "discord" &&
      ids.includes(row.messageId) &&
      row.endpoint?.channelId === [...msgs.values()][0]?.channelId
  );
  const seenGroups = new Set();

  for (const row of sourceRows) {
    if (seenGroups.has(row.linkGroup)) continue;
    seenGroups.add(row.linkGroup);
    await deleteLogicalMessage(row.linkGroup, client);
  }
}

/**
 * @param {import("discord.js").Channel} channel
 * @param {import("discord.js").Client} client
 */
export async function DiscordPinsUpdateHandler(channel, client) {
  log("DEBUG", `DiscordPinsUpdate received channelId=${channel.id}`);

  const endpoints = await findEndpoints("discord", channel.id);
  const sourceKind = endpoints[0]?.kind ?? "channel";
  if (sourceKind === "thread") return;

  const sourceEndpoints = endpoints.filter(e => e.kind === "channel");
  if (sourceEndpoints.length === 0) return;

  const pinnedMessages = await channel.messages.fetchPins();
  const pinnedIds = pinnedMessages.items.map(x => x.message.id);

  const pinnedRows = await MessageLink.findAll({
    where: { messageId: { [Op.in]: pinnedIds } },
    include: ["endpoint"],
  });
  const ownPinnedGroups = new Set(
    pinnedRows.filter(r => r.endpoint?.platform === "discord" && r.endpoint?.channelId === channel.id).map(r => r.linkGroup)
  );

  for (const entry of await collectTargets(sourceEndpoints, "discord", { kind: "channel", excludeChannelId: channel.id })) {
    if (entry.endpoints[0].platform !== "fluxer") continue;
    const targetEndpoint = entry.endpoints[0];
    const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);

    const fluxerChannel = await fluxerClient.channels.fetch(targetEndpoint.channelId).catch(() => null);
    if (!fluxerChannel?.isTextBased?.()) continue;

    const fluxerPinned = await fluxerChannel.fetchPinnedMessages();
    const fluxerPinnedIds = fluxerPinned.map(x => x.id);

    const localRows = await MessageLink.findAll({
      where: { linkGroup: [...ownPinnedGroups], endpointId: targetEndpoint.id },
    });

    for (const local of localRows) {
      if (!fluxerPinnedIds.includes(local.messageId)) {
        try {
          const msg = await (await fluxerClient.channels.fetch(targetEndpoint.channelId)).messages.fetch(local.messageId);
          await msg.pin();
        } catch {}
      }
    }

    const targetPinnedRows = await MessageLink.findAll({
      where: { messageId: { [Op.in]: fluxerPinnedIds }, endpointId: targetEndpoint.id },
    });
    for (const targetRow of targetPinnedRows) {
      const sourceCopy = await MessageLink.findOne({
        where: { linkGroup: targetRow.linkGroup, endpointId: sourceEndpoints[0].id },
      });
      if (sourceCopy && !pinnedIds.includes(sourceCopy.messageId)) {
        try {
          await fluxerClient.rest.patch(FluxerRoutes.channelMessage(targetEndpoint.channelId, targetRow.messageId), {
            body: { pinned: false },
          });
        } catch {}
      }
    }
  }
}
