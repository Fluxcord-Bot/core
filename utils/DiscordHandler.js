import { ChannelType, MessageFlags, MessageType } from "discord.js";
import { Routes as FluxerRoutes } from "@fluxerjs/core";
import { ChannelMap, MessageMap } from "../db/index.js";
import Config from "../utils/ConfigHandler.js";
import { CommandHandler } from "./CommandHandler.js";
import { Op } from "sequelize";
import truncate from "truncate";
import { readFileSync } from "node:fs";
import { discordEmbedToFluxer } from "./EmbedConverter.js";
import { parseDiscordEmojiToFluxer, removeLinkEmbeds, traverseMessageLinks } from "./EmojiStickerParser.js";
import { attemptParseBridgedMessage, parseMentions } from "./MessageContentParser.js";
import { sanitizePings } from "./SanitizePings.js";
import { sendErrorMessage } from "./SendErrorMessage.js";
import { log } from "./Logger.js";
import { getGuildPrefix } from "./GetGuildPrefix.js";
import { sendFluxerWebhook } from "./FluxerWebhookSend.js";
import { isDiscordSpoilerAttachment, SPOILER_ATTACHMENT_FLAG } from "./SpoilerAttachments.js";
import { checkEmbedPerms, checkPingPerms } from "./CheckManageServerPerms.js";
import { normalizeFcJson } from "./NormalizeJson.js";
import { cacheUser, resolveMentions } from "./MentionResolver.js";
import { resetBridgeHealth } from "./BridgeHealth.js";
import { isBridgeToggleEnabled } from "./BridgeToggle.js";
import { processSticker } from "./StickerProcessor.js";
import { indicatorPrefix, resolveNameIndicator, withIndicator } from "./NameIndicator.js";
import { maybePublishFluxerMessage } from "./AnnouncementPublish.js";
import {
  autoBridgeDiscordThread,
  backfillMirroredThread,
  fluxerThreadIdFor,
  fluxerWebhookChannelIdFor,
  waitForPendingMirror,
} from "./ThreadMirror.js";
import { isFluxerRateLimited, withFluxerRateLimit } from "./FluxerRateLimit.js";
import { isUserOptedOut } from "./UserOptOut.js";
import { waitForMessageMap } from "./WaitForMessageMap.js";

let fluxcordBotEmojiCfg = undefined;

const MAX_ATTACHMENT_SIZE = 24999900; // 25 MB, discord default max

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

async function deleteFluxerMessage(client, channelMap, messageId) {
  await client.rest.delete(FluxerRoutes.channelMessage(channelMap.fluxerChannelId, messageId));
}

async function deleteFluxerMessageIfExists(client, channelMap, messageId) {
  if (!messageId) return;

  try {
    await deleteFluxerMessage(client, channelMap, messageId);
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

const webhookListCache = new Map();

async function hasFluxerWebhook(fluxerClient, channelId, webhookId) {
  const cached = webhookListCache.get(channelId);
  if (cached && Date.now() - cached.at < 60_000 && cached.ids.has(webhookId)) return true;
  const channel = await fluxerClient.channels.fetch(channelId);
  const webhooks = await /** @type {import("@fluxerjs/core").GuildChannel} */ (channel).fetchWebhooks();
  const ids = new Set(webhooks.map(x => x.id));
  webhookListCache.set(channelId, { at: Date.now(), ids });
  return ids.has(webhookId);
}

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean>>} message
 * @param {DiscordClient} client
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
async function mirrorExistingThread(threadId, parentId, discordClient, fluxerClient) {
  const parentRow = await ChannelMap.findOne({ where: { discordChannelId: parentId }, raw: true });
  if (!parentRow || parentRow.bridgeType === "fluxer2discord") return null;
  const thread = await discordClient.channels.fetch(threadId).catch(() => null);
  if (!thread || thread.type === ChannelType.PrivateThread) return null;
  const row = await autoBridgeDiscordThread(thread, parentRow, discordClient, fluxerClient);
  if (!row) return null;
  log("DEBUG", `DiscordCreate mirrored on activity thread ${thread.id} rowId=${row.id}`);
  await backfillMirroredThread(thread, message => DiscordCreateMessageHandler(message, discordClient, fluxerClient, true));
  return row;
}

export async function DiscordCreateMessageHandler(message, client, fluxerClient, doNotExecuteCommand = false) {
  log(
    "DEBUG",
    `DiscordCreate received id=${message.id} channelId=${message.channelId} guildId=${message.guildId} authorId=${message.author?.id} type=${message.type} hasReference=${Boolean(message.reference)}`
  );
  cacheUser(message.author);

  if (!fluxcordBotEmojiCfg) fluxcordBotEmojiCfg = JSON.parse(readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8"));

  fluxcordBotEmojiCfg = normalizeFcJson(fluxcordBotEmojiCfg);

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

  const guildPrefix = await getGuildPrefix(message.guildId);
  if (message.content.startsWith(guildPrefix)) {
    log("DEBUG", `DiscordCreate id=${message.id} isCommand=${!doNotExecuteCommand}`);
    if (doNotExecuteCommand) return;
    await CommandHandler(message, client, fluxerClient);
    return;
  }

  if (await isUserOptedOut("discord", message.author.id)) {
    log("DEBUG", `DiscordCreate skip id=${message.id} authorId=${message.author.id} reason=userOptOut`);
    return;
  }

  const channelMapViaUserId = await ChannelMap.findOne({
    where: {
      [Op.or]: {
        discordWebhookId: message.author.id,
        fluxerWebhookId: message.author.id,
      },
    },
  });

  if (channelMapViaUserId) {
    log("DEBUG", `DiscordCreate skip id=${message.id} authorId=${message.author.id} reason=webhookAuthor`);
    return;
  }

  const isLoadingInteraction = message.type === MessageType.ChatInputCommand && message.flags.has("Loading");

  if (isLoadingInteraction) {
    log("DEBUG", `DiscordCreate defer id=${message.id} reason=loadingInteraction`);
    setTimeout(async () => {
      try {
        await DiscordCreateMessageHandler(message, client, fluxerClient);
      } catch (e) {
        await sendErrorMessage(message, client, fluxerClient, e);
      }
    }, 5000);
    return;
  }

  let channelMap = await ChannelMap.findOne({
    where: {
      discordChannelId: message.channelId,
    },
    raw: true,
  });

  if (!channelMap) {
    const known = message.channel;
    const thread = known?.isThread?.()
      ? known
      : !known || known.partial
        ? await discordClient.channels.fetch(message.channelId).catch(() => null)
        : null;
    if (thread?.isThread?.()) {
      channelMap = await waitForPendingMirror("discord", message.channelId);
      if (channelMap) {
        log("DEBUG", `DiscordCreate id=${message.id} resolved pending mirror for thread ${message.channelId}`);
      } else if (thread.parentId) {
        channelMap = await mirrorExistingThread(message.channelId, thread.parentId, client, fluxerClient);
        if (channelMap) return;
      }
    }
  }

  if (channelMap?.bridgeType === "fluxer2discord") {
    log(
      "DEBUG",
      `DiscordCreate skip id=${message.id} channelId=${message.channelId} reason=oneWayBridge bridgeType=${channelMap.bridgeType}`
    );
    return;
  }

  if (!channelMap || channelMap.discordWebhookId === message.webhookId) {
    log(
      "DEBUG",
      `DiscordCreate skip id=${message.id} channelId=${message.channelId} reason=${!channelMap ? "noChannelMap" : "webhookEcho"} webhookId=${message.webhookId ?? "none"}`
    );
    return;
  }

  let reroutedFluxerMessageId = null;
  let reroutedMessageMap = null;
  if (channelMap.autoMirrored) {
    reroutedMessageMap = await MessageMap.findOne({
      where: { discordMessageId: message.id },
    });
    if (
      reroutedMessageMap &&
      (reroutedMessageMap.channelMapId === channelMap.id || reroutedMessageMap.fluxerMessageId === channelMap.fluxerChannelId)
    ) {
      reroutedFluxerMessageId = reroutedMessageMap.fluxerMessageId;
    } else {
      reroutedMessageMap = null;
    }
  }

  if (channelMap.autoMirrored && message.id === channelMap.discordChannelId && reroutedMessageMap) {
    log("DEBUG", `DiscordCreate skip id=${message.id} reason=postHead`);
    return;
  }

  let fluxerThreadId = null;
  if (channelMap.autoMirrored) {
    fluxerThreadId = await fluxerThreadIdFor(fluxerClient, channelMap);
  }

  const nameIndicator = await resolveNameIndicator(channelMap.fluxerGuildId, message.guildId);

  let forwardedMessage;
  if (message.reference?.type === 1 && message.type !== MessageType.UserJoin && message.flags !== MessageFlags.IsCrosspost) {
    forwardedMessage = message.messageSnapshots.first();
  }

  log(
    "DEBUG",
    `DiscordCreate bridge start id=${message.id} channelMapId=${channelMap.id} hasForward=${Boolean(forwardedMessage)} attachmentCount=${(forwardedMessage ?? message).attachments?.size ?? 0} embedCount=${(forwardedMessage ?? message).embeds?.length ?? 0} stickerCount=${(forwardedMessage ?? message).stickers?.size ?? 0}`
  );

  const bridgeContent = await attemptParseBridgedMessage(message);

  /** @type {import("../db/models/MessageMap.js").MessageMap | null} */
  let messageReference;
  if (message.reference || bridgeContent.isBridge || bridgeContent.isProxy) {
    messageReference = await MessageMap.findOne({
      where: {
        [Op.or]: [
          {
            discordMessageId: message.reference?.messageId ?? "",
          },
          {
            discordMessageId: bridgeContent.messageData.messageId ?? "",
          },
          {
            fluxerMessageId: message.reference?.messageId ?? "",
          },
        ],
      },
    });

    if (messageReference && messageReference.channelMapId !== channelMap?.id) {
      messageReference = null;
    }
  }

  if (!messageReference && message.reference?.messageId && message.reference.type !== 1) {
    const referencedMessage = await resolveDiscordReference(message, client);
    if (referencedMessage) {
      messageReference = await waitForMessageMap(
        "discord",
        referencedMessage.id,
        channelMap.id,
        referencedMessage.author?.id,
        referencedMessage.createdAt
      );
    }
  }

  const hasUnbridgedReference =
    !forwardedMessage &&
    !messageReference &&
    message.reference?.type !== 1 &&
    Boolean(message.reference?.messageId || bridgeContent.messageData?.messageId);

  const stickerFiles = [];
  const stickerFallbacks = []; // Throw the cdn in the message if something unexpected happens
  const stickerLottie = []; // Discord does this for some of their native stickers. Ick.

  for (const sticker of message.stickers.values()) {
    if (sticker.url?.endsWith("json")) {
      stickerLottie.push(sticker.name);
      continue;
    }

    const stickerUrl = sticker.url;
    const isAnimated = stickerUrl.endsWith(".gif") || sticker.format === 2;
    const processed = await processSticker(stickerUrl, {
      animated: isAnimated,
      name: sticker.name,
    });

    if (processed) {
      stickerFiles.push({ name: processed.filename, data: processed.buffer });
    } else {
      log("WARN", `[StickerRoute] Sticker ${sticker.id} processing returned empty or null. Adding fallback.`);
      stickerFallbacks.push(`[${sticker.name}](${stickerUrl})`);
    }
  }

  let stickerMsg = "";
  if (stickerLottie.length > 0) {
    stickerMsg = `-# Message contains stickers: ${stickerLottie.join(", ")}`;
  }
  if (stickerFallbacks.length > 0) {
    stickerMsg += (stickerMsg ? "\n" : "") + stickerFallbacks.join(", ");
  }

  const interactingUser = message.interaction ? message.interactionMetadata?.user : undefined;
  const userJoin =
    message.type === MessageType.UserJoin
      ? `*${indicatorPrefix("discord", nameIndicator)}@${message.author.tag} joined the bridged server*`
      : "";

  const bridgeAttachments = (forwardedMessage ?? message).attachments.filter(x => x.size < MAX_ATTACHMENT_SIZE);
  const webhookFiles = bridgeAttachments
    .map(a => ({
      name: a.name,
      url: a.url ?? a.proxyURL,
      flags: isDiscordSpoilerAttachment(a) ? SPOILER_ATTACHMENT_FLAG : undefined,
      description: a.description,
    }))
    .concat(stickerFiles);

  const fastUsername = withIndicator(
    message.author.displayName ?? message.author.globalName ?? "Fluxcord",
    "discord",
    nameIndicator
  );

  let earlyFluxerMsgId = reroutedFluxerMessageId;
  let earlyMessageReferenceOption;
  if (messageReference && !forwardedMessage) {
    earlyMessageReferenceOption = {
      message_id: messageReference.fluxerMessageId,
    };
  }
  const sourceText =
    (forwardedMessage?.content || bridgeContent.messageData.parsedContent || (forwardedMessage ?? message).content) ?? "";
  const customEmojiCount = countCustomEmojis(sourceText) + ((forwardedMessage ?? message).stickers?.size ?? 0);
  log(
    "DEBUG",
    `DiscordCreate emoji check id=${message.id} emojiCount=${customEmojiCount} threshold=${earlyBridgeEmojiThreshold} contentLength=${sourceText?.length ?? 0} ltCount=${sourceText?.split("<").length - 1 ?? 0} colonCount=${sourceText?.split(":").length - 1 ?? 0} hasForward=${Boolean(forwardedMessage)} isBridge=${bridgeContent.isBridge} isProxy=${bridgeContent.isProxy}`
  );
  let guildUser = undefined;
  try {
    guildUser = await message.guild.members.fetch(message.author.id);
  } catch {}
  const canUserEmbed = message.webhookId
    ? true
    : await checkEmbedPerms(message.guildId, message.channelId, message.author.id, client);
  if (customEmojiCount >= earlyBridgeEmojiThreshold && !earlyFluxerMsgId && !isFluxerRateLimited(`webhook:${channelMap.fluxerWebhookId}`)) {
    const loadingEmoji = fluxcordBotEmojiCfg.fluxerLoadingEmoji ? `<${fluxcordBotEmojiCfg.fluxerLoadingEmoji}>` : "⏳";
    const loadingText =
      sourceText.replace(/<a?:.+?:\d+>/g, loadingEmoji) ||
      `${loadingEmoji} Bridging message with ${customEmojiCount} custom emojis...`;
    try {
      const earlyMsg = await sendFluxerWebhook(channelMap.fluxerWebhookId, channelMap.fluxerWebhookToken, fluxerClient, {
        content:
          (forwardedMessage
            ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> Forwarded\n`
            : "") +
          loadingText +
          stickerMsg +
          userJoin,
        username: fastUsername,
        avatar_url: guildUser?.avatarURL() ?? message.author.avatarURL() ?? undefined,
        files: webhookFiles,
        message_reference: earlyMessageReferenceOption,
        allowed_mentions: { parse: [] },
        flags: canUserEmbed ? undefined : 4,
        ...(fluxerThreadId ? { threadId: fluxerThreadId } : {}),
      });
      earlyFluxerMsgId = earlyMsg?.id ?? null;
      log("DEBUG", `DiscordCreate early bridge id=${message.id} fluxerId=${earlyFluxerMsgId} emojiCount=${customEmojiCount}`);
    } catch (e) {
      log("FLUXER", `Early bridge placeholder failed for ${message.id}`, e);
    }
  }

  const webhookChannelId = await fluxerWebhookChannelIdFor(channelMap);
  const webhook = (await hasFluxerWebhook(fluxerClient, webhookChannelId, channelMap.fluxerWebhookId))
    ? channelMap.fluxerWebhookId
    : null;
  if (!webhook) {
    if (earlyFluxerMsgId) {
      try {
        await deleteFluxerMessageIfExists(fluxerClient, channelMap, earlyFluxerMsgId);
      } catch {}
    }
    return;
  }

  const overAttachments = (forwardedMessage ?? message).attachments.filter(x => x.size > 24999900);
  const overAttachmentsStr = overAttachments.map(x => `[${x.name}](<${x.url ?? x.proxyURL}>)`).join(" ");
  if (webhook) {
    const otherSideGuild = await fluxerClient.guilds.fetch(channelMap.fluxerGuildId);
    const canUserPing = await checkPingPerms(message.guildId, message.author.id, client);
    const everyonePingsEnabled = await isBridgeToggleEnabled(channelMap, "everyonePingEnabled");
    const canBridgePing = canUserPing && everyonePingsEnabled;
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
            await parseMentions(forwardedMessage ?? message, bridgeContent.messageData.parsedContent, otherSideGuild),
            canBridgePing && !forwardedMessage
          )
        ),
        fluxerClient,
        channelMap.fluxerGuildId
      )
    );
    parsedContent = await refreshDiscordCdnLinks(parsedContent, client, message.id);

    let messageReferenceOption;
    if (messageReference && !forwardedMessage) {
      messageReferenceOption = { message_id: messageReference.fluxerMessageId };
    }

    let webhookContent =
      (forwardedMessage
        ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> Forwarded\n`
        : "") +
      (hasUnbridgedReference
        ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> Unbridged message\n`
        : "") +
      (interactingUser
        ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> ${indicatorPrefix("discord", nameIndicator)}@${interactingUser.tag} used \`/${message.interaction?.commandName}\`\n`
        : "") +
      (message.flags.has(MessageFlags.IsComponentsV2) ? "*Components V2 message*" : "") +
      parsedContent +
      stickerMsg +
      userJoin +
      (overAttachmentsStr ? "\n-# has attachments over 25mb: " + overAttachmentsStr : "");
    const webhookUsername = guildUser?.displayName
      ? withIndicator(guildUser.displayName, "discord", nameIndicator)
      : fastUsername;
    const wEmbeds = (forwardedMessage ?? message).embeds;
    if (message.type === MessageType.PollResult) {
      const fields = Object.fromEntries(message.embeds[0]?.fields?.map(x => [x.name, x.value]) ?? {});
      const totalVotes = Number(fields.total_votes) || 0;
      const victorVotes = Number(fields.victor_answer_votes) || 0;
      const pct = totalVotes > 0 ? Math.round((victorVotes / totalVotes) * 100) : 0;
      webhookContent = `-# ${webhookUsername}'s poll has closed! The winner was ${fields.victor_answer_text} (${pct}%)`;
      wEmbeds.length = 0;
    }
    if (typeof bridgeContent.excludeEmbed === "number") wEmbeds.splice(bridgeContent.excludeEmbed, 1);
    const webhookEmbeds = await Promise.all(
      wEmbeds.filter(x => !x.url || !webhookContent.includes(x.url)).map(async x => await discordEmbedToFluxer(x, fluxerClient))
    );
    if (!webhookContent.trim() && webhookFiles.length === 0 && webhookEmbeds.length === 0) {
      log("WARN", `[DiscordHandler] Webhook content is empty and no files or embeds are present for message ${message.id}.`);
      webhookContent = message.poll ? "-# Sent a poll" : "-# Sent an unsupported sticker or empty message";
    }

    let msg;
    if (earlyFluxerMsgId) {
      try {
        await withFluxerRateLimit(
          () =>
            fluxerClient.rest.patch(
              `/webhooks/${channelMap.fluxerWebhookId}/${channelMap.fluxerWebhookToken}/messages/${earlyFluxerMsgId}${fluxerThreadId ? `?thread_id=${fluxerThreadId}` : ""}`,
              {
                body: {
                  content: webhookContent,
                  embeds: webhookEmbeds,
                  allowed_mentions: webhookAllowedMentions,
                  flags: webhookFlags,
                },
                auth: false,
              }
            ),
          `webhook-patch:${channelMap.fluxerWebhookId}`
        );
      } catch (e) {
        log("FLUXER", `Failed to edit early bridged Fluxer message ${earlyFluxerMsgId}`, e);
      }
      msg = { id: earlyFluxerMsgId };
    } else {
      msg = await sendFluxerWebhook(channelMap.fluxerWebhookId, channelMap.fluxerWebhookToken, fluxerClient, {
        content: webhookContent,
        username: webhookUsername,
        avatar_url: guildUser?.avatarURL() ?? message.author.avatarURL() ?? undefined,
        embeds: webhookEmbeds,
        files: webhookFiles,
        message_reference: messageReferenceOption,
        allowed_mentions: webhookAllowedMentions,
        flags: webhookFlags,
        ...(fluxerThreadId ? { threadId: fluxerThreadId } : {}),
      });
    }

    resetBridgeHealth(message.guildId);

    try {
      await maybePublishFluxerMessage(fluxerClient, channelMap, msg?.id);
    } catch {}

    log(
      "DEBUG",
      `DiscordCreate bridged discordId=${message.id} fluxerId=${msg?.id} channelMapId=${channelMap.id} fileCount=${webhookFiles.length} embedCount=${webhookEmbeds.length} hasReply=${Boolean(messageReferenceOption)}`
    );

    let bridgedMessageMap;
    if (!reroutedFluxerMessageId) {
      try {
        bridgedMessageMap = await MessageMap.create({
          messageSource: "discord",
          discordMessageId: message.id,
          fluxerMessageId: msg?.id,
          fluxerReplyId: messageReference?.fluxerMessageId ?? null,
          discordReplyId: message.reference?.messageId ?? null,
          channelMapId: channelMap.id,
          authorId: message.author.id,
        });
      } catch (e) {
        log("DB", "Failed to save Discord -> Fluxer message map", e);
      }
    }

    const checkMsg = async () => {
      try {
        const channel = await message.channel.fetch();
        if (channel.isSendable()) {
          await channel.messages.fetch(message.id);
        }
      } catch (e) {
        if (isDiscordUnknownMessageError(e)) {
          try {
            await deleteFluxerMessageIfExists(fluxerClient, channelMap, msg?.id);
          } catch (deleteError) {
            log("FLUXER", `Failed to delete bridged Fluxer message ${msg?.id}`, deleteError);
          }

          await bridgedMessageMap?.destroy();
          await reroutedMessageMap?.destroy();
          return;
        }

        log("DISCORD", "Could not verify source Discord message before mapping bridged Fluxer message", e);
      }
    };
    setTimeout(checkMsg, 1000);
    setTimeout(checkMsg, 2500);
    setTimeout(checkMsg, 5000);
  }
}

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean> | import("discord.js").PartialMessage<boolean>>} oldMsg
 * @param {import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean>>} newMsg
 * @param {FluxerClient} client
 */
export async function DiscordUpdateMessageHandler(oldMsg, newMsg, client) {
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

  if (await isUserOptedOut("discord", authorId)) return;

  const messageExisting = await MessageMap.findOne({
    where: {
      discordMessageId: newMsg.id,
    },
    include: ["channelMap"],
  });

  const channelMapViaUserId = await ChannelMap.findOne({
    where: {
      [Op.or]: {
        discordWebhookId: authorId,
        fluxerWebhookId: authorId,
      },
    },
  });

  if (channelMapViaUserId) {
    if (
      messageExisting &&
      newMsg.flags?.has?.(MessageFlags.SuppressEmbeds) !== oldMsg?.flags?.has?.(MessageFlags.SuppressEmbeds)
    ) {
      const mirrorSuppressed = newMsg.flags.has(MessageFlags.SuppressEmbeds);
      const original = await client.rest.get(
        FluxerRoutes.channelMessage(messageExisting.channelMap.fluxerChannelId, messageExisting.fluxerMessageId)
      );
      const originalFlags = original.flags ?? 0;
      if (Boolean(originalFlags & 4) !== mirrorSuppressed) {
        await client.rest.patch(
          FluxerRoutes.channelMessage(messageExisting.channelMap.fluxerChannelId, messageExisting.fluxerMessageId),
          {
            body: {
              flags: mirrorSuppressed ? originalFlags | 4 : originalFlags & ~4,
            },
          }
        );
      }
    }
    return;
  }

  if (messageExisting) {
    const channelMap = messageExisting.channelMap;

    const bridgeContent = await attemptParseBridgedMessage(newMsg);

    /** @type {import("../db/models/MessageMap.js").MessageMap | null} */
    let messageReference;
    if (newMsg.reference || bridgeContent.isBridge || bridgeContent.isProxy) {
      messageReference = await MessageMap.findOne({
        where: {
          [Op.or]: [
            {
              discordMessageId: newMsg.reference?.messageId ?? "",
            },
            {
              discordMessageId: bridgeContent.messageData.messageId ?? "",
            },
            {
              fluxerMessageId: newMsg.reference?.messageId ?? "",
            },
          ],
        },
      });

      if (messageReference && messageReference.channelMapId !== channelMap.id) {
        messageReference = null;
      }
    }

    const hasUnbridgedReference =
      !messageReference &&
      newMsg.reference?.type !== 1 &&
      Boolean(newMsg.reference?.messageId || bridgeContent.messageData?.messageId);

    const canUserPing = await checkPingPerms(newMsg.guildId, newMsg.author.id, client);
    const canUserEmbed = newMsg.webhookId
      ? true
      : await checkEmbedPerms(newMsg.guildId, newMsg.channelId, newMsg.author.id, newMsg.client);
    const everyonePingsEnabled = await isBridgeToggleEnabled(channelMap, "everyonePingEnabled");
    const canBridgePing = canUserPing && everyonePingsEnabled;

    const wEmbeds = newMsg.embeds;
    if (typeof bridgeContent.excludeEmbed === "number") wEmbeds.splice(bridgeContent.excludeEmbed, 1);
    const otherSideGuild = await client.guilds.fetch(channelMap.fluxerGuildId);
    let newContent =
      (hasUnbridgedReference
        ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> Unbridged message\n`
        : "") +
      (await traverseMessageLinks(
        await parseDiscordEmojiToFluxer(
          await resolveMentions(
            otherSideGuild,
            sanitizePings(await parseMentions(newMsg, bridgeContent.messageData.parsedContent, otherSideGuild), canBridgePing)
          ),
          client,
          channelMap.fluxerGuildId
        )
      ));

    newContent = await refreshDiscordCdnLinks(newContent, newMsg.client, newMsg.id);

    const newEmbeds = await Promise.all(
      wEmbeds.filter(x => !x.url || !newContent.includes(x.url)).map(async x => await discordEmbedToFluxer(x, client))
    );

    const suppressEmbeds = newMsg.flags?.has?.(MessageFlags.SuppressEmbeds) ?? false;
    const suppressNotifications = newMsg.flags?.has?.(MessageFlags.SuppressNotifications) ?? false;

    if (!newContent && newEmbeds.length === 0 && !suppressEmbeds) {
      log("DEBUG", `DiscordUpdate skip id=${newMsg.id} reason=emptyEdit`);
      return;
    }

    log(
      "DEBUG",
      `DiscordUpdate bridged discordId=${newMsg.id} fluxerId=${messageExisting.fluxerMessageId} channelMapId=${channelMap.id} embedCount=${newEmbeds.length}`
    );

    const fluxerThreadId = channelMap.autoMirrored ? await fluxerThreadIdFor(client, channelMap) : null;

    await withFluxerRateLimit(
      () =>
        client.rest.patch(
          `/webhooks/${channelMap.fluxerWebhookId}/${channelMap.fluxerWebhookToken}/messages/${messageExisting.fluxerMessageId}${fluxerThreadId ? `?thread_id=${fluxerThreadId}` : ""}`,
          {
            body: {
              content: newContent,
              embeds: newEmbeds,
              flags: (suppressEmbeds || !canUserEmbed ? 4 : 0) | (suppressNotifications ? 4096 : 0),
            },
            auth: false,
          }
        ),
      `webhook-patch:${channelMap.fluxerWebhookId}`
    );
  }
}

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<DiscordMessage<boolean> | import("discord.js").PartialMessage<boolean>>} msg
 * @param {FluxerClient} client
 */
export async function DiscordDeleteMessageHandler(msg, client) {
  log("DEBUG", `DiscordDelete received id=${msg.id} channelId=${msg.channelId}`);
  const messageExisting = await MessageMap.findOne({
    where: {
      discordMessageId: msg.id,
    },
    include: ["channelMap"],
  });

  if (!messageExisting) {
    log("DEBUG", `DiscordDelete skip id=${msg.id} reason=noMap`);
    return;
  }

  const channelMap = messageExisting.channelMap;
  if (!channelMap) {
    log("DISCORD", `Message map ${messageExisting.id} for Discord message ${msg.id} has no channel map`);
    await messageExisting.destroy();
    return;
  }

  try {
    await deleteFluxerMessageIfExists(client, channelMap, messageExisting.fluxerMessageId);
  } catch (e) {
    log("FLUXER", `Failed to delete bridged Fluxer message ${messageExisting.fluxerMessageId} for Discord message ${msg.id}`, e);
    return;
  }

  await messageExisting.destroy();
}

/**
 * @param {import("discord.js").ReadonlyCollection<string, Message<true> | import("discord.js").PartialMessage<true>>} msgs
 * @param {FluxerClient} client
 */
export async function DiscordBulkDeleteMessageHandler(msgs, client) {
  log("DEBUG", `DiscordBulkDelete received count=${msgs.size}`);
  const messagesExisting = await MessageMap.findAll({
    where: {
      discordMessageId: {
        [Op.in]: msgs.map(x => x.id),
      },
    },
    include: ["channelMap"],
  });

  if (messagesExisting.length > 0) {
    const channel = /** @type {GuildChannel} */ (
      await client.channels.fetch(messagesExisting[0]?.channelMap.fluxerChannelId ?? "")
    );

    const reply = await channel.send({
      content: `Bridging bulk deletes, please wait...`,
    });

    await channel.bulkDelete(messagesExisting.map(x => x.fluxerMessageId));

    await Promise.all(messagesExisting.map(async x => await x.destroy()));

    await reply.delete();
  }
}

/**
 * @param {import("discord.js").TextBasedChannel} channel
 * @param {FluxerClient} client
 */
export async function DiscordPinsUpdateHandler(channel, client) {
  log("DEBUG", `DiscordPinsUpdate received channelId=${channel.id}`);
  const channelMap = await ChannelMap.findOne({
    where: {
      discordChannelId: channel.id,
    },
  });

  if (channelMap) {
    const pinnedMessages = await channel.messages.fetchPins();

    const messages = await MessageMap.findAll({
      where: {
        discordMessageId: {
          [Op.in]: pinnedMessages.items.map(x => x.message.id),
        },
      },
    });

    const fluxerChannel = /** @type {TextChannel} */ (await client.channels.fetch(channelMap?.fluxerChannelId));

    if (fluxerChannel) {
      const fluxerPinned = await fluxerChannel.fetchPinnedMessages();
      const fluxerMessageBridgePinned = (
        await Promise.all(messages.map(async x => await fluxerChannel.messages.fetch(x.fluxerMessageId)))
      ).filter(x => !fluxerPinned.includes(x));

      const fluxerPinnedBridged = await MessageMap.findAll({
        where: {
          fluxerMessageId: {
            [Op.in]: fluxerPinned.map(x => x.id),
          },
        },
      });
      const fluxerPinnedRemove = fluxerPinned
        .filter(x => fluxerPinnedBridged.find(y => y.fluxerMessageId === x.id))
        .filter(x => !messages.find(y => y.fluxerMessageId === x.id));

      await Promise.all(fluxerPinnedRemove.map(async x => x.unpin()));
      await Promise.all(fluxerMessageBridgePinned.map(async x => x.pin()));
    }
  }
}
