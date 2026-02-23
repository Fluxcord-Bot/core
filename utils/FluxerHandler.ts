import {
  Client as DiscordClient,
  TextChannel,
  type GatewayMessageDeleteBulkDispatchData,
  type TextBasedChannel,
} from "discord.js";
import {
  Message as FluxerMessage,
  type PartialMessage as FluxerPartialMessage,
  Client as FluxerClient,
  TextChannel as FluxerTextChannel,
} from "@fluxerjs/core";
import { ChannelMap, MessageMap, sequelize, UserConfig } from "../db";
import Config from "../config";
import { CommandHandler } from "./CommandHandler";
import { log } from "./Logger";
import { Op } from "sequelize";
import truncate from "truncate";
import { readFileSync } from "node:fs";
import { parseFluxerEmojiToDiscord } from "./EmojiStickerParser";
import { checkManageServerPerms } from "./CheckManageServerPerms";
import { fluxerEmbedToDiscord } from "./EmbedConverter";

let fluxcordBotEmojiCfg: any = undefined;

export async function FluxerCreateMessageHandler(
  message: FluxerMessage,
  client: FluxerClient,
  discordClient: DiscordClient,
  proxyCompatibility?: boolean,
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

  const userConfig = await UserConfig.findOne({
    where: {
      userId: message.author.id,
    },
  });
  if (userConfig && userConfig.proxyCompatibility && !proxyCompatibility) {
    setTimeout(
      async () =>
        await FluxerCreateMessageHandler(message, client, discordClient, true),
      2000,
    );
    return;
  }

  if (proxyCompatibility) {
    const messageMap = await MessageMap.findOne({
      where: {
        [Op.and]: [
          sequelize.where(sequelize.fn("LOWER", sequelize.col("content")), {
            [Op.like]: `%${message.content.slice(2, message.content.length - 2)}%`,
          }),
          {
            createdAt: {
              [Op.gte]: new Date(Date.now() - 5000),
            },
          },
        ],
      },
    });

    if (messageMap) return;
  }

  const channelMap = await ChannelMap.findOne({
    where: {
      fluxerChannelId: message.channelId,
    },
    raw: true,
  });

  if (channelMap?.bridgeType === "discord2fluxer") return;

  let messageReference: MessageMap | null;
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
      ? `*@${message.author.username}#${message.author.discriminator} joined the bridged community*`
      : "";

  if (!channelMap || channelMap.fluxerWebhookId === message.webhookId) return;

  const stickers = message.stickers.map((x) => `${x.name}`);

  const stickerMsg =
    stickers.length > 0
      ? `\n-# Message contains stickers: ${stickers.join(", ")}`
      : "";

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
      (await parseFluxerEmojiToDiscord(message.content, discordClient)) +
      userJoin +
      stickerMsg,
    files: message.attachments.map((a) => a.proxy_url ?? a.url ?? ""),
    username:
      message.author.globalName ??
      message.author.username + "#" + message.author.discriminator,
    embeds: await fluxerEmbedToDiscord(message, discordClient),
    avatarURL: message.author.avatarURL() ?? undefined,
  });

  await MessageMap.create({
    messageSource: "fluxer",
    discordMessageId: msg.id,
    fluxerMessageId: message.id,
    channelMapId: channelMap.id,
    authorId: message.author.id,
    content: await parseFluxerEmojiToDiscord(message.content, discordClient),
  });
}

export async function FluxerUpdateMessageHandler(
  oldMessage: FluxerMessage | null,
  newMessage: FluxerMessage,
  client: DiscordClient,
) {
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

    let messageReference: MessageMap | null;
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

export async function FluxerDeleteMessageHandler(
  message: FluxerPartialMessage,
  client: DiscordClient,
) {
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

export async function FluxerBulkDeleteMessageHandler(
  msgs: {
    channel_id: string;
    guild_id?: string;
    ids: string[];
  },
  client: DiscordClient,
) {
  const messagesExisting = await MessageMap.findAll({
    where: {
      fluxerMessageId: {
        [Op.in]: msgs.ids,
      },
    },
    include: ["channelMap"],
  });

  if (messagesExisting.length > 0) {
    const channel = (await client.channels.fetch(
      messagesExisting[0]?.channelMap.fluxerChannelId ?? "",
    )) as TextChannel;

    const reply = await channel.send({
      content: `Bridging bulk deletes, please wait...`,
    });

    await channel.bulkDelete(messagesExisting.map((x) => x.discordMessageId));

    await reply.delete();
  }
}

export async function FluxerPinsUpdateHandler(
  chnl: {
    channel_id: string;
  },
  client: DiscordClient,
  fluxerClient: FluxerClient,
) {
  const channelMap = await ChannelMap.findOne({
    where: {
      fluxerChannelId: chnl.channel_id,
    },
  });

  if (channelMap) {
    const channel = (await fluxerClient.channels.fetch(
      chnl.channel_id,
    )) as FluxerTextChannel;

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
