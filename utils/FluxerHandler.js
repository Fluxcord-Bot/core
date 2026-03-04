import { ChannelMap, MessageMap, sequelize, UserConfig } from "../db/index.js";
import Config from "../utils/ConfigHandler.js";
import { CommandHandler } from "./CommandHandler.js";
import { Op } from "sequelize";
import truncate from "truncate";
import { readFileSync } from "node:fs";
import { parseFluxerEmojiToDiscord } from "./EmojiStickerParser.js";
import { fluxerEmbedToDiscord } from "./EmbedConverter.js";
import { parseMentions } from "./MessageContentParser.js";
import { detectProxyCommandCompat } from "./AutoProxyCompat.js";
import { sendErrorMessage } from "./SendErrorMessage.js";
import fuzzyMatching from "fuzzymatchingjs";

let fluxcordBotEmojiCfg = undefined;

/**
 * @param {import("@fluxerjs/core").Message} message
 * @param {import("@fluxerjs/core").Client} client
 * @param {import("discord.js").Client} discordClient
 * @param {boolean} [proxyCompatibility]
 */
export async function FluxerCreateMessageHandler(
  message,
  client,
  discordClient,
  proxyCompatibility,
) {
  if (!fluxcordBotEmojiCfg)
    fluxcordBotEmojiCfg = JSON.parse(
      readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8"),
    );

  if (!message.guildId || message.type === 6) return;
  if (message.content.startsWith(Config.BotPrefix)) {
    CommandHandler(message, discordClient, client);
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

  if (channelMapViaUserId) return;

  await detectProxyCommandCompat(message);

  const userConfig = await UserConfig.findOne({
    where: {
      userId: message.author.id,
    },
  });
  if (userConfig && userConfig.proxyCompatibility && !proxyCompatibility) {
    setTimeout(async () => {
      try {
        await FluxerCreateMessageHandler(message, client, discordClient, true);
      } catch (e) {
        await sendErrorMessage(message, discordClient, client, e);
      }
    }, 5000);
    return;
  }

  if (proxyCompatibility) {
    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: {
          fluxerChannelId: message.channelId,
          discordChannelId: message.channelId,
        },
      },
    });
    if (channelMap) {
      const messageMap = await MessageMap.findAll({
        where: {
          channelMapId: channelMap.id,
        },
        limit: 5,
        order: [["createdAt", "DESC"]],
      });

      if (
        messageMap.find((x) => {
          const res = fuzzyMatching.confidenceScore(x.content, message.content);
          return res > 0.8 || message.content.endsWith(x.content);
        })
      )
        return;
    }
  }

  const channelMap = await ChannelMap.findOne({
    where: {
      fluxerChannelId: message.channelId,
    },
    raw: true,
  });

  if (channelMap?.bridgeType === "discord2fluxer") return;

  /** @type {import("../db/models/MessageMap.js").MessageMap | null} */
  let messageReference;
  if (message.messageReference) {
    messageReference = await MessageMap.findOne({
      where: {
        [Op.or]: [
          {
            fluxerMessageId: message.messageReference.message_id,
          },
          {
            discordMessageId: message.messageReference.message_id,
          },
        ],
      },
    });
  }

  const userJoin =
    message.type === 7
      ? `*@${message.author.username}${message.author.discriminator !== "0000" ? `#${message.author.discriminator}` : ""} joined the bridged community*`
      : "";

  if (!channelMap || channelMap.fluxerWebhookId === message.webhookId) return;

  const stickers = message.stickers.map((x) => `${x.name}`);

  const stickerMsg =
    stickers.length > 0
      ? `\n-# Message contains stickers: ${stickers.join(", ")}`
      : "";

  const overAttachments = message.attachments.filter((x) => x.size > 9999000);
  const overAttachmentsStr = overAttachments
    .map((x) => `[${x.filename}](${x.url})`)
    .join(" ");

  const webhook = await discordClient.fetchWebhook(
    channelMap.discordWebhookId,
    channelMap.discordWebhookToken,
  );
  const msg = await webhook.send({
    content:
      // @ts-expect-error
      (messageReference
        ? `-# <:reply_l:${fluxcordBotEmojiCfg.discordReplyEmoji.replyL}><:reply_r:${fluxcordBotEmojiCfg.discordReplyEmoji.replyR}> ${messageReference.messageSource === "discord" ? `<@${messageReference.authorId}>` : `@${message.referencedMessage?.author.username}#${message.referencedMessage?.author.discriminator}`} (https://discord.com/channels/${channelMap.discordGuildId}/${channelMap.discordChannelId}/${messageReference.discordMessageId}): ${truncate(messageReference.content, 25)}\n`
        : "") +
      (await parseFluxerEmojiToDiscord(
        await parseMentions(message),
        discordClient,
      )) +
      userJoin +
      stickerMsg +
      (overAttachmentsStr
        ? "\n-# has attachments over 10mb: " + overAttachmentsStr
        : ""),
    files: message.attachments
      .filter((x) => x.size < 9999000)
      .map((a) => a.proxy_url ?? a.url ?? ""),
    username: message.author.globalName ?? message.author.username,
    embeds: await fluxerEmbedToDiscord(message, discordClient),
    avatarURL: message.author.avatarURL() ?? undefined,
  });

  await MessageMap.create({
    messageSource: "fluxer",
    discordMessageId: msg.id,
    fluxerMessageId: message.id,
    channelMapId: channelMap.id,
    authorId: message.author.id,
    content: await parseFluxerEmojiToDiscord(
      await parseMentions(message),
      discordClient,
    ),
  });
}

/**
 * @param {FluxerMessage | null} oldMessage
 * @param {FluxerMessage} newMessage
 * @param {DiscordClient} client
 */
export async function FluxerUpdateMessageHandler(
  oldMessage,
  newMessage,
  client,
) {
  const channelMapViaUserId = await ChannelMap.findOne({
    where: {
      [Op.or]: {
        discordWebhookId: newMessage.author.id,
        fluxerWebhookId: newMessage.author.id,
      },
    },
  });

  if (channelMapViaUserId) return;

  const messageExisting = await MessageMap.findOne({
    where: {
      fluxerMessageId: newMessage.id,
    },
    include: ["channelMap"],
  });

  if (messageExisting) {
    const channelMap = messageExisting.channelMap;
    const webhook = await client.fetchWebhook(
      channelMap.discordWebhookId,
      channelMap.discordWebhookToken,
    );

    /** @type {import("../db/models/MessageMap.js").MessageMap | null} */
    let messageReference;
    if (newMessage.messageReference) {
      messageReference = await MessageMap.findOne({
        where: {
          [Op.or]: [
            {
              fluxerMessageId: newMessage.messageReference.message_id,
            },
            {
              discordMessageId: newMessage.messageReference.message_id,
            },
          ],
        },
      });
    }

    await webhook.editMessage(messageExisting.discordMessageId, {
      content:
        // @ts-expect-error
        (messageReference
          ? `-# <:reply_l:${fluxcordBotEmojiCfg.discordReplyEmoji.replyL}><:reply_r:${fluxcordBotEmojiCfg.discordReplyEmoji.replyR}> ${messageReference.messageSource === "discord" ? `<@${messageReference.authorId}>` : `@${newMessage.referencedMessage?.author.username}#${newMessage.referencedMessage?.author.discriminator}`} (https://discord.com/channels/${channelMap.discordGuildId}/${channelMap.discordChannelId}/${messageReference.discordMessageId}): ${truncate(messageReference.content, 25)}\n`
          : "") + newMessage.content,
      files: newMessage.attachments.map((a) => a.url ?? ""),
    });

    messageExisting.content = newMessage.content;
    await messageExisting.save();
  }
}

/**
 * @param {import("@fluxerjs/core").PartialMessage} message
 * @param {DiscordClient} client
 */
export async function FluxerDeleteMessageHandler(message, client) {
  const channelMapViaUserId = await ChannelMap.findOne({
    where: {
      [Op.or]: {
        discordWebhookId: message.authorId,
        fluxerWebhookId: message.authorId,
      },
    },
  });

  if (channelMapViaUserId) return;

  const messageExisting = await MessageMap.findOne({
    where: {
      fluxerMessageId: message.id,
    },
    include: ["channelMap"],
  });

  if (messageExisting) {
    const channelMap = messageExisting.channelMap;
    const webhook = await client.fetchWebhook(
      channelMap.discordWebhookId,
      channelMap.discordWebhookToken,
    );

    await webhook.deleteMessage(messageExisting.discordMessageId);
    await messageExisting.destroy();
  }
}

/**
 * @param {{ channel_id: string; guild_id?: string; ids: string[] }} msgs
 * @param {DiscordClient} client
 */
export async function FluxerBulkDeleteMessageHandler(msgs, client) {
  const messagesExisting = await MessageMap.findAll({
    where: {
      fluxerMessageId: {
        [Op.in]: msgs.ids,
      },
    },
    include: ["channelMap"],
  });

  if (messagesExisting.length > 0) {
    const channel = /** @type {TextChannel} */ (
      await client.channels.fetch(
        messagesExisting[0]?.channelMap.fluxerChannelId ?? "",
      )
    );

    const reply = await channel.send({
      content: `Bridging bulk deletes, please wait...`,
    });

    await channel.bulkDelete(messagesExisting.map((x) => x.discordMessageId));

    await reply.delete();
  }
}

/**
 * @param {{ channel_id: string }} chnl
 * @param {DiscordClient} client
 * @param {FluxerClient} fluxerClient
 */
export async function FluxerPinsUpdateHandler(chnl, client, fluxerClient) {
  const channelMap = await ChannelMap.findOne({
    where: {
      fluxerChannelId: chnl.channel_id,
    },
  });

  if (channelMap) {
    const channel = /** @type {FluxerTextChannel} */ (
      await fluxerClient.channels.fetch(chnl.channel_id)
    );

    if (channel) {
      const pinned = await channel.fetchPinnedMessages();

      const messages = await MessageMap.findAll({
        where: {
          fluxerMessageId: {
            [Op.in]: pinned.map((x) => x.id),
          },
        },
      });

      const discordChannel = await client.channels.fetch(
        channelMap.discordChannelId,
      );

      if (discordChannel && discordChannel.isTextBased()) {
        const discordPinned = await discordChannel.messages.fetchPins();

        const discordMessageBridgePinned = (
          await Promise.all(
            messages.map(
              async (x) =>
                await discordChannel.messages.fetch(x.discordMessageId),
            ),
          )
        ).filter(
          (x) => !discordPinned.items.find((y) => x.id === y.message.id),
        );

        const discordPinnedBridged = await MessageMap.findAll({
          where: {
            discordMessageId: {
              [Op.in]: discordPinned.items.map((x) => x.message.id),
            },
          },
        });

        const discordPinnedRemove = discordPinned.items
          .filter((x) =>
            discordPinnedBridged.find(
              (y) => y.discordMessageId === x.message.id,
            ),
          )
          .filter(
            (x) => !messages.find((y) => y.discordMessageId === x.message.id),
          );

        await Promise.all(
          discordPinnedRemove.map(async (x) => x.message.unpin()),
        );
        await Promise.all(discordMessageBridgePinned.map(async (x) => x.pin()));
      }
    }
  }
}
