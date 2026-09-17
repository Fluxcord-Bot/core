import { MessageFlags, MessageType } from "discord.js";
import { Routes as FluxerRoutes } from "@fluxerjs/core";
import { ChannelMap, MessageMap, UserConfig } from "../db/index.js";
import Config from "../utils/ConfigHandler.js";
import { CommandHandler } from "./CommandHandler.js";
import { Op } from "sequelize";
import truncate from "truncate";
import { readFileSync } from "node:fs";
import { discordEmbedToFluxer } from "./EmbedConverter.js";
import {
  parseDiscordEmojiToFluxer,
  removeLinkEmbeds,
  traverseMessageLinks,
} from "./EmojiStickerParser.js";
import {
  attemptParseBridgedMessage,
  parseMentions,
} from "./MessageContentParser.js";
import { sanitizePings } from "./SanitizePings.js";
import { sendErrorMessage } from "./SendErrorMessage.js";
import { log } from "./Logger.js";
import { getGuildPrefix } from "./GetGuildPrefix.js";
import { sendFluxerWebhook } from "./FluxerWebhookSend.js";
import {
  isDiscordSpoilerAttachment,
  SPOILER_ATTACHMENT_FLAG,
} from "./SpoilerAttachments.js";
import { checkPingPerms } from "./CheckManageServerPerms.js";
import { normalizeFcJson } from "./NormalizeJson.js";
import { cacheUser, resolveMentions } from "./MentionResolver.js";
import { resetBridgeHealth } from "./BridgeHealth.js";
import { processSticker } from "./StickerProcessor.js"


let fluxcordBotEmojiCfg = undefined;

const MAX_ATTACHMENT_SIZE = 24999900 // 25 MB, discord default max

function isDiscordUnknownMessageError(error) {
  return (
    error?.code === 10008 ||
    (error?.status === 404 && /unknown message/i.test(error?.message ?? ""))
  );
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
  await client.rest.delete(
    FluxerRoutes.channelMessage(channelMap.fluxerChannelId, messageId),
  );
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

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean>>} message
 * @param {DiscordClient} client
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export async function DiscordCreateMessageHandler(
  message,
  client,
  fluxerClient,
  doNotExecuteCommand = false,
) {
  log(
    "DEBUG",
    `DiscordCreate received id=${message.id} channelId=${message.channelId} guildId=${message.guildId} authorId=${message.author?.id} type=${message.type} hasReference=${Boolean(message.reference)}`,
  );
  cacheUser(message.author);

  if (!fluxcordBotEmojiCfg)
    fluxcordBotEmojiCfg = JSON.parse(
      readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8"),
    );

  fluxcordBotEmojiCfg = normalizeFcJson(fluxcordBotEmojiCfg);

  if (
    !message.guildId ||
    message.type === MessageType.ChannelPinnedMessage ||
    message.type === MessageType.ThreadCreated
  ) {
    log(
      "DEBUG",
      `DiscordCreate skip id=${message.id} reason=unsupportedGuildOrType type=${message.type}`,
    );
    return;
  }

  const guildPrefix = await getGuildPrefix(message.guildId);
  if (message.content.startsWith(guildPrefix)) {
    log(
      "DEBUG",
      `DiscordCreate id=${message.id} isCommand=${!doNotExecuteCommand}`,
    );
    if (doNotExecuteCommand) return;
    CommandHandler(message, client, fluxerClient);
    return;
  }

  const userOptOut = await UserConfig.findOne({
    where: {
      userType: "discord",
      userId: message.author.id,
      doNotBridgePrefix: "__opted_out__",
    },
  });

  if (userOptOut) {
    log(
      "DEBUG",
      `DiscordCreate skip id=${message.id} authorId=${message.author.id} reason=userOptOut`,
    );
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
    log(
      "DEBUG",
      `DiscordCreate skip id=${message.id} authorId=${message.author.id} reason=webhookAuthor`,
    );
    return;
  }

  const isLoadingInteraction =
    message.type === MessageType.ChatInputCommand &&
    message.flags.has("Loading");

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

  const channelMap = await ChannelMap.findOne({
    where: {
      discordChannelId: message.channelId,
    },
    raw: true,
  });

  if (channelMap?.bridgeType === "fluxer2discord") {
    log(
      "DEBUG",
      `DiscordCreate skip id=${message.id} channelId=${message.channelId} reason=oneWayBridge bridgeType=${channelMap.bridgeType}`,
    );
    return;
  }

  if (!channelMap || channelMap.discordWebhookId === message.webhookId) {
    log(
      "DEBUG",
      `DiscordCreate skip id=${message.id} channelId=${message.channelId} reason=${!channelMap ? "noChannelMap" : "webhookEcho"} webhookId=${message.webhookId ?? "none"}`,
    );
    return;
  }

  let forwardedMessage;
  if (
    message.reference?.type === 1 &&
    message.type !== MessageType.UserJoin &&
    message.flags !== MessageFlags.IsCrosspost
  ) {
    forwardedMessage = message.messageSnapshots.first();
  }

  log(
    "DEBUG",
    `DiscordCreate bridge start id=${message.id} channelMapId=${channelMap.id} hasForward=${Boolean(forwardedMessage)} attachmentCount=${(forwardedMessage ?? message).attachments?.size ?? 0} embedCount=${(forwardedMessage ?? message).embeds?.length ?? 0} stickerCount=${(forwardedMessage ?? message).stickers?.size ?? 0}`,
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

  const stickerFiles = [];
  const stickerFallbacks = []; // Throw the cdn in the message if something unexpected happens
  const stickerLottie = []; // Discord does this for some of their native stickers. Ick.

  for (const sticker of message.stickers.values()) {
    if (sticker.url?.endsWith("json")) {
      stickerLottie.push(sticker.name);
      continue;
    }

    const stickerUrl = sticker.url;
    const processed = await processSticker(stickerUrl, { animated: stickerUrl.endsWith(".gif"), name: sticker.name });

    if (processed) {
      stickerFiles.push({ name: processed.filename, data: processed.buffer });
    } else {
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

  const interactingUser = message.interaction
    ? message.interactionMetadata?.user
    : undefined;
  const userJoin =
    message.type === MessageType.UserJoin
      ? `*@${message.author.tag} joined the bridged server*`
      : "";

  const bridgeAttachments = (forwardedMessage ?? message).attachments.filter(
    (x) => x.size < MAX_ATTACHMENT_SIZE,
  );
  const webhookFiles = bridgeAttachments.map((a) => ({
    name: a.name,
    url: a.proxyURL ?? a.url,
    flags: isDiscordSpoilerAttachment(a)
      ? SPOILER_ATTACHMENT_FLAG
      : undefined,
    description: a.description,
  })).concat(stickerFiles);

  const fastUsername =
    message.author.displayName ?? message.author.globalName ?? "Fluxcord";

  let earlyFluxerMsgId = null;
  let earlyMessageReferenceOption;
  if (messageReference && !forwardedMessage) {
    earlyMessageReferenceOption = {
      message_id: messageReference.fluxerMessageId,
    };
  }
  const sourceText =
    (forwardedMessage?.content ||
      bridgeContent.messageData.parsedContent ||
      (forwardedMessage ?? message).content) ??
    "";
  const customEmojiCount =
    countCustomEmojis(sourceText) +
    ((forwardedMessage ?? message).stickers?.size ?? 0);
  log(
    "DEBUG",
    `DiscordCreate emoji check id=${message.id} emojiCount=${customEmojiCount} threshold=${earlyBridgeEmojiThreshold} contentLength=${sourceText?.length ?? 0} ltCount=${sourceText?.split("<").length - 1 ?? 0} colonCount=${sourceText?.split(":").length - 1 ?? 0} hasForward=${Boolean(forwardedMessage)} isBridge=${bridgeContent.isBridge} isProxy=${bridgeContent.isProxy}`,
  );
  if (customEmojiCount >= earlyBridgeEmojiThreshold) {
    const loadingEmoji = fluxcordBotEmojiCfg.fluxerLoadingEmoji
      ? `<${fluxcordBotEmojiCfg.fluxerLoadingEmoji}>`
      : "⏳";
    const loadingText =
      sourceText.replace(/<a?:.+?:\d+>/g, loadingEmoji) ||
      `${loadingEmoji} Bridging message with ${customEmojiCount} custom emojis...`;
    try {
      const earlyMsg = await sendFluxerWebhook(
        channelMap.fluxerWebhookId,
        channelMap.fluxerWebhookToken,
        fluxerClient,
        {
          content:
            (forwardedMessage
              ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> Forwarded\n`
              : "") +
            loadingText +
            stickerMsg +
            userJoin,
          username: fastUsername,
          avatar_url: message.author.avatarURL() ?? undefined,
          files: webhookFiles,
          message_reference: earlyMessageReferenceOption,
          allowed_mentions: { parse: [] },
        },
      );
      earlyFluxerMsgId = earlyMsg?.id ?? null;
      log(
        "DEBUG",
        `DiscordCreate early bridge id=${message.id} fluxerId=${earlyFluxerMsgId} emojiCount=${customEmojiCount}`,
      );
    } catch (e) {
      log("FLUXER", `Early bridge placeholder failed for ${message.id}`, e);
    }
  }

  const channel = await fluxerClient.channels.fetch(channelMap.fluxerChannelId);
  const webhooks = await /** @type {import("@fluxerjs/core").GuildChannel} */ (
    channel
  ).fetchWebhooks();
  const webhook = webhooks.find((x) => x.id === channelMap.fluxerWebhookId);
  if (!webhook) {
    if (earlyFluxerMsgId) {
      try {
        await deleteFluxerMessageIfExists(
          fluxerClient,
          channelMap,
          earlyFluxerMsgId,
        );
      } catch { }
    }
    return;
  }
  const overAttachments = (forwardedMessage ?? message).attachments.filter(
    (x) => x.size > 24999900,
  );
  const overAttachmentsStr = overAttachments
    .map((x) => `[${x.name}](${x.url})`)
    .join(" ");
  if (webhook) {
    let guildUser = undefined;
    try {
      guildUser = await message.guild.members.fetch(message.author.id);
    } catch { }
    const otherSideGuild = await fluxerClient.guilds.fetch(
      channelMap.fluxerGuildId,
    );
    const canUserPing = await checkPingPerms(
      message.guildId,
      message.author.id,
      client,
    );
    const parsedContent = await traverseMessageLinks(
      await parseDiscordEmojiToFluxer(
        await resolveMentions(
          otherSideGuild,
          sanitizePings(
            await parseMentions(
              forwardedMessage ?? message,
              bridgeContent.messageData.parsedContent,
              otherSideGuild,
            ),
            canUserPing,
          ),
        ),
        fluxerClient,
        channelMap.fluxerGuildId,
      ),
    );

    let messageReferenceOption;
    if (messageReference && !forwardedMessage) {
      messageReferenceOption = { message_id: messageReference.fluxerMessageId };
    }

    const webhookContent =
      (forwardedMessage
        ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> Forwarded\n`
        : "") +
      (interactingUser
        ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> @${interactingUser.tag} used \`/${message.interaction?.commandName}\`\n`
        : "") +
      (message.flags.has(MessageFlags.IsComponentsV2)
        ? "*Components V2 message*"
        : "") +
      parsedContent +
      stickerMsg +
      userJoin +
      (overAttachmentsStr
        ? "\n-# has attachments over 25mb: " + overAttachmentsStr
        : "");
    const webhookUsername =
      guildUser?.displayName ?? fastUsername;
    const wEmbeds = (forwardedMessage ?? message).embeds;
    if (typeof bridgeContent.excludeEmbed === "number")
      wEmbeds.splice(bridgeContent.excludeEmbed, 1);
    const webhookEmbeds = await Promise.all(
      wEmbeds
        .filter((x) => !x.url || !webhookContent.includes(x.url))
        .map(async (x) => await discordEmbedToFluxer(x, fluxerClient)),
    );

    let msg;
    if (earlyFluxerMsgId) {
      try {
        await fluxerClient.rest.patch(
          `/webhooks/${channelMap.fluxerWebhookId}/${channelMap.fluxerWebhookToken}/messages/${earlyFluxerMsgId}`,
          {
            body: {
              content: webhookContent,
              embeds: webhookEmbeds,
            },
            auth: false,
          },
        );
      } catch (e) {
        log(
          "FLUXER",
          `Failed to edit early bridged Fluxer message ${earlyFluxerMsgId}`,
          e,
        );
      }
      msg = { id: earlyFluxerMsgId };
    } else {
      msg = await sendFluxerWebhook(
        channelMap.fluxerWebhookId,
        channelMap.fluxerWebhookToken,
        fluxerClient,
        {
          content: webhookContent,
          username: webhookUsername,
          avatar_url: message.author.avatarURL() ?? undefined,
          embeds: webhookEmbeds,
          files: webhookFiles,
          message_reference: messageReferenceOption,
          allowed_mentions: {
            parse: ["users", "roles", ...(canUserPing ? ["everyone"] : [])],
            replied_user: true,
          },
        },
      );
    }

    resetBridgeHealth(message.guildId);

    log(
      "DEBUG",
      `DiscordCreate bridged discordId=${message.id} fluxerId=${msg?.id} channelMapId=${channelMap.id} fileCount=${webhookFiles.length} embedCount=${webhookEmbeds.length} hasReply=${Boolean(messageReferenceOption)}`,
    );

    let bridgedMessageMap;
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

    const checkMsg = async () => {
      try {
        const channel = await message.channel.fetch();
        if (channel.isSendable()) {
          await channel.messages.fetch(message.id);
        }
      } catch (e) {
        if (isDiscordUnknownMessageError(e)) {
          try {
            await deleteFluxerMessageIfExists(
              fluxerClient,
              channelMap,
              msg?.id,
            );
          } catch (deleteError) {
            log(
              "FLUXER",
              `Failed to delete bridged Fluxer message ${msg?.id}`,
              deleteError,
            );
          }

          await bridgedMessageMap?.destroy();
          return;
        }

        log(
          "DISCORD",
          "Could not verify source Discord message before mapping bridged Fluxer message",
          e,
        );
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
    `DiscordUpdate received id=${newMsg.id} channelId=${newMsg.channelId ?? oldMsg.channelId} guildId=${newMsg.guildId ?? oldMsg.guildId} authorId=${authorId}`,
  );

  const userOptOut = await UserConfig.findOne({
    where: {
      userType: "discord",
      userId: authorId,
      doNotBridgePrefix: "__opted_out__",
    },
  });

  if (userOptOut) return;

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

  if (channelMapViaUserId) return;

  if (messageExisting) {
    const channelMap = messageExisting.channelMap;

    const bridgeContent = await attemptParseBridgedMessage(newMsg);

    const canUserPing = await checkPingPerms(
      newMsg.guildId,
      newMsg.author.id,
      client,
    );

    const wEmbeds = newMsg.embeds;
    if (typeof bridgeContent.excludeEmbed === "number")
      wEmbeds.splice(bridgeContent.excludeEmbed, 1);
    const otherSideGuild = await client.guilds.fetch(channelMap.fluxerGuildId);
    const newContent = await traverseMessageLinks(
      await parseDiscordEmojiToFluxer(
        await resolveMentions(
          otherSideGuild,
          sanitizePings(
            await parseMentions(
              newMsg,
              bridgeContent.messageData.parsedContent,
              otherSideGuild,
            ),
            canUserPing,
          ),
        ),
        client,
        channelMap.fluxerGuildId,
      ),
    );

    const newEmbeds = await Promise.all(
      wEmbeds
        .filter((x) => !x.url || !newContent.includes(x.url))
        .map(async (x) => await discordEmbedToFluxer(x, client)),
    );

    if (!newContent && newEmbeds.length === 0) {
      log("DEBUG", `DiscordUpdate skip id=${newMsg.id} reason=emptyEdit`);
      return;
    }

    log(
      "DEBUG",
      `DiscordUpdate bridged discordId=${newMsg.id} fluxerId=${messageExisting.fluxerMessageId} channelMapId=${channelMap.id} embedCount=${newEmbeds.length}`,
    );

    await client.rest.patch(
      `/webhooks/${channelMap.fluxerWebhookId}/${channelMap.fluxerWebhookToken}/messages/${messageExisting.fluxerMessageId}`,
      {
        body: {
          content: newContent,
          embeds: newEmbeds,
        },
        auth: false,
      },
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
    log(
      "DISCORD",
      `Message map ${messageExisting.id} for Discord message ${msg.id} has no channel map`,
    );
    await messageExisting.destroy();
    return;
  }

  try {
    await deleteFluxerMessageIfExists(
      client,
      channelMap,
      messageExisting.fluxerMessageId,
    );
  } catch (e) {
    log(
      "FLUXER",
      `Failed to delete bridged Fluxer message ${messageExisting.fluxerMessageId} for Discord message ${msg.id}`,
      e,
    );
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
        [Op.in]: msgs.map((x) => x.id),
      },
    },
    include: ["channelMap"],
  });

  if (messagesExisting.length > 0) {
    const channel = /** @type {GuildChannel} */ (
      await client.channels.fetch(
        messagesExisting[0]?.channelMap.fluxerChannelId ?? "",
      )
    );

    const reply = await channel.send({
      content: `Bridging bulk deletes, please wait...`,
    });

    await channel.bulkDelete(messagesExisting.map((x) => x.fluxerMessageId));

    await Promise.all(messagesExisting.map(async (x) => await x.destroy()));

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
          [Op.in]: pinnedMessages.items.map((x) => x.message.id),
        },
      },
    });

    const fluxerChannel = /** @type {TextChannel} */ (
      await client.channels.fetch(channelMap?.fluxerChannelId)
    );

    if (fluxerChannel) {
      const fluxerPinned = await fluxerChannel.fetchPinnedMessages();
      const fluxerMessageBridgePinned = (
        await Promise.all(
          messages.map(
            async (x) => await fluxerChannel.messages.fetch(x.fluxerMessageId),
          ),
        )
      ).filter((x) => !fluxerPinned.includes(x));

      const fluxerPinnedBridged = await MessageMap.findAll({
        where: {
          fluxerMessageId: {
            [Op.in]: fluxerPinned.map((x) => x.id),
          },
        },
      });
      const fluxerPinnedRemove = fluxerPinned
        .filter((x) =>
          fluxerPinnedBridged.find((y) => y.fluxerMessageId === x.id),
        )
        .filter((x) => !messages.find((y) => y.fluxerMessageId === x.id));

      await Promise.all(fluxerPinnedRemove.map(async (x) => x.unpin()));
      await Promise.all(fluxerMessageBridgePinned.map(async (x) => x.pin()));
    }
  }
}
