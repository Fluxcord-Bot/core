import { Client as DiscordClient } from "discord.js";
import {
  Message as FluxerMessage,
  type PartialMessage as FluxerPartialMessage,
  Client as FluxerClient,
} from "@fluxerjs/core";
import { ChannelMap, MessageMap } from "../db";
import Config from "../config";
import { CommandHandler } from "./CommandHandler";
import { log } from "./Logger";
import { Op } from "sequelize";
import truncate from "truncate";
import { readFileSync } from "node:fs";
import { parseFluxerEmojiToDiscord } from "./EmojiStickerParser";
import { checkManageServerPerms } from "./CheckManageServerPerms";

let fluxcordBotEmojiCfg: any = undefined;

export async function FluxerCreateMessageHandler(
  message: FluxerMessage,
  client: FluxerClient,
  discordClient: DiscordClient,
) {
  if (!fluxcordBotEmojiCfg)
    fluxcordBotEmojiCfg = JSON.parse(
      readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8"),
    );

  if (!message.guildId) return;
  if (message.content.startsWith(Config.BotPrefix)) {
    if (
      await checkManageServerPerms(message.guildId, message.author.id, client)
    ) {
      CommandHandler(message, discordClient, client);
      return;
    } else {
      log(
        "FLUXER",
        `User ${message.author.id} on guild ${message.guild} does not have ManageGuild perms, treating message as normal message...`,
      );
    }
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

  if (!channelMap || channelMap.fluxerWebhookId === message.webhookId) return;

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
      (await parseFluxerEmojiToDiscord(message.content, discordClient)),
    files: message.attachments.map((a) => a.proxy_url ?? a.url ?? ""),
    username:
      message.author.globalName ??
      message.author.username + "#" + message.author.discriminator,
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
