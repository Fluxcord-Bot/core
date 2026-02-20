import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
  PermissionFlagsBits as DiscordPermissionFlagsBits,
  TextChannel as DiscordTextChannel,
  type MessageReference
} from "discord.js";
import { Message as FluxerMessage, type PartialMessage as FluxerPartialMessage, Client as FluxerClient, PermissionFlags, GuildChannel as FluxerGuildChannel } from "@fluxerjs/core";
import { ChannelMap, MessageMap } from "../db";
import Config from "../config";
import { CommandHandler } from "./CommandHandler";
import { log } from "./Logger";
import { Op } from "sequelize";
import truncate from "truncate";
import { readFileSync } from "node:fs";
import { discordEmbedToFluxer } from "./EmbedConverter";
import { parseDiscordEmojiToFluxer } from "./EmojiParser";

let fluxcordBotEmojiCfg: any = undefined

export async function FluxerCreateMessageHandler(message: FluxerMessage, client: FluxerClient, discordClient: DiscordClient) {
  if (!fluxcordBotEmojiCfg) fluxcordBotEmojiCfg = JSON.parse(readFileSync(Config.DataFolderPath + '/fluxcord.json', 'utf-8'))

  if (!message.guildId) return;
  if (message.content.startsWith(Config.BotPrefix)) {
    if (await checkManageServerPerms(message.guildId, message.author.id, client)) {
      CommandHandler(message, discordClient, client);
      return; 
    } else {
      log('FLUXER', `User ${message.author.id} on guild ${message.guild} does not have ManageGuild perms, treating message as normal message...`)
    }
  }

  const channelMap = await ChannelMap.findOne({
    where: {
      fluxerChannelId: message.channelId
    },
    raw: true
  })

  let messageReference: MessageMap | null;
  if (message.messageReference) {
    messageReference = await MessageMap.findOne({
      where: {
        [Op.or]: [
          {
            fluxerMessageId: message.messageReference.message_id
          },
          {
            discordMessageId: message.messageReference.message_id
          }
        ]
      }
    })
  }

  if (!channelMap || channelMap.fluxerWebhookId === message.webhookId) return;

  const webhook = await discordClient.fetchWebhook(channelMap.discordWebhookId, channelMap.discordWebhookToken)
  const msg = await webhook.send({
    // @ts-expect-error
    content: (messageReference ? `-# <:reply_l:${fluxcordBotEmojiCfg.discordReplyEmoji.replyL}><:reply_r:${fluxcordBotEmojiCfg.discordReplyEmoji.replyR}> ${messageReference.messageSource === 'discord' ? `<@${messageReference.authorId}>`: `@${message.referencedMessage?.author.username}#${message.referencedMessage?.author.discriminator}`}: ${truncate(messageReference.content, 25)}\n` : '')
        + message.content,
    username: message.author.globalName ?? 'Fluxcord',
    avatarURL: message.author.avatarURL() ?? undefined,
  })

  await MessageMap.create({
    messageSource: 'fluxer',
    discordMessageId: msg.id,
    fluxerMessageId: message.id,
    channelMapId: channelMap.id,
    authorId: message.author.id,
    content: message.content
  })
}

export async function FluxerUpdateMessageHandler(oldMessage: FluxerMessage | null, newMessage: FluxerMessage, client: FluxerClient) {}

export async function FluxerDeleteMessageHandler(message: FluxerPartialMessage, client: FluxerClient) {}

export async function DiscordCreateMessageHandler(
  message: OmitPartialGroupDMChannel<DiscordMessage<boolean>>, client: DiscordClient, fluxerClient: FluxerClient
) {
  if (!fluxcordBotEmojiCfg) fluxcordBotEmojiCfg = JSON.parse(readFileSync(Config.DataFolderPath + '/fluxcord.json', 'utf-8'))

  if (!message.guildId) return;
  if (message.content.startsWith(Config.BotPrefix)) {
    if (await checkManageServerPerms(message.guildId, message.author.id, client)) {
      CommandHandler(message, client, fluxerClient);
      return; 
    } else {
      log('DISCORD', `User ${message.author.id} on guild ${message.guild} does not have ManageGuild perms, treating message as normal message...`)
    }
  }

  const channelMap = await ChannelMap.findOne({
    where: {
      discordChannelId: message.channelId
    },
    raw: true
  })

  if (!channelMap || channelMap.discordWebhookId === message.webhookId) return;
  
  let messageReference: MessageMap | null;
  if (message.reference) {
    messageReference = await MessageMap.findOne({
      where: {
        [Op.or]: [
          {
            discordMessageId: message.reference.messageId
          },
          {
            fluxerMessageId: message.reference.messageId
          }
        ]
      }
    })
  }

  const channel = await fluxerClient.channels.fetch(channelMap.fluxerChannelId)
  const webhooks = await (channel as FluxerGuildChannel).fetchWebhooks()
  const webhook = webhooks.find(x => x.id === channelMap.fluxerWebhookId)
  if (webhook) {
    const msg = await webhook.send({
      // @ts-expect-error
      content: (messageReference ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> ${messageReference.messageSource === 'fluxer' ? `<@${messageReference.authorId}>`: `@${(await message.fetchReference()).author.tag}`}: ${truncate(messageReference.content, 25)}\n` : '')
        + await parseDiscordEmojiToFluxer(message.content, fluxerClient),
      username: message.author.displayName ?? 'Fluxcord',
      avatar_url: message.author.avatarURL() ?? undefined,
      embeds: await Promise.all(message.embeds.map(async x => await discordEmbedToFluxer(x, fluxerClient)))
    }, true)

    await MessageMap.create({
      messageSource: 'discord',
      discordMessageId: msg?.id,
      fluxerMessageId: message.id,
      content: await parseDiscordEmojiToFluxer(message.content, fluxerClient),
      channelMapId: channelMap.id,
      authorId: message.author.id
    })
  }
}  

async function checkManageServerPerms(guildId: string, userId: string, client: FluxerClient | DiscordClient) {
  const guild = await client.guilds.fetch(guildId)
  if (!guild) return false;
  const user = await guild.members.fetch({
    user: userId
  })
  if (Array.isArray(user)) {
    return user[0]?.permissions.has(PermissionFlags.ManageGuild) ||
      user[0]?.permissions.has(PermissionFlags.Administrator) || guild.ownerId == userId
  } else {
    return user.permissions.has(DiscordPermissionFlagsBits.ManageGuild) ||
      user.permissions.has(DiscordPermissionFlagsBits.Administrator) || guild.ownerId == user.id
  }
}
