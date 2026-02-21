import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
  PermissionFlagsBits as DiscordPermissionFlagsBits,
  TextChannel as DiscordTextChannel,
  type MessageReference,
  AttachmentBuilder,
  type PartialMessage as DiscordPartialMessage,
} from "discord.js";
import {
  Message as FluxerMessage,
  type PartialMessage as FluxerPartialMessage,
  Client as FluxerClient,
  PermissionFlags,
  GuildChannel as FluxerGuildChannel,
  TextChannel,
} from "@fluxerjs/core";
import { ChannelMap, MessageMap } from "../db";
import Config from "../config";
import { CommandHandler } from "./CommandHandler";
import { log } from "./Logger";
import { Op } from "sequelize";
import truncate from "truncate";
import { readFileSync } from "node:fs";
import { discordEmbedToFluxer } from "./EmbedConverter";
import {
  parseDiscordEmojiToFluxer,
  parseFluxerEmojiToDiscord,
} from "./EmojiParser";

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

export async function DiscordCreateMessageHandler(
  message: OmitPartialGroupDMChannel<DiscordMessage<boolean>>,
  client: DiscordClient,
  fluxerClient: FluxerClient,
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
      CommandHandler(message, client, fluxerClient);
      return;
    } else {
      log(
        "DISCORD",
        `User ${message.author.id} on guild ${message.guild} does not have ManageGuild perms, treating message as normal message...`,
      );
    }
  }

  const channelMap = await ChannelMap.findOne({
    where: {
      discordChannelId: message.channelId,
    },
    raw: true,
  });

  if (channelMap?.bridgeType === "fluxer2discord") return;

  if (!channelMap || channelMap.discordWebhookId === message.webhookId) return;

  let messageReference: MessageMap | null;
  if (message.reference) {
    messageReference = await MessageMap.findOne({
      where: {
        [Op.or]: [
          {
            discordMessageId: message.reference.messageId,
          },
          {
            fluxerMessageId: message.reference.messageId,
          },
        ],
      },
    });
  }

  const interactingUser = message.interaction
    ? message.interactionMetadata?.user
    : undefined;
  const channel = await fluxerClient.channels.fetch(channelMap.fluxerChannelId);
  const webhooks = await (channel as FluxerGuildChannel).fetchWebhooks();
  const webhook = webhooks.find((x) => x.id === channelMap.fluxerWebhookId);
  if (webhook) {
    const msg = await webhook.send(
      {
        content:
          (interactingUser
            ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> @${interactingUser.tag} used \`/${message.interaction?.commandName}\``
            : "") +
          // @ts-expect-error
          (messageReference
            ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> ${messageReference.messageSource === "fluxer" ? `<@${messageReference.authorId}>` : `@${(await message.fetchReference()).author.tag}`} (https://fluxer.app/channels/${channelMap.fluxerGuildId}/${channelMap.fluxerChannelId}/${messageReference.fluxerMessageId}): ${truncate(messageReference.content, 25)}\n`
            : "") +
          (await parseDiscordEmojiToFluxer(message.content, fluxerClient)),
        username:
          message.author.displayName ?? message.author.globalName ?? "Fluxcord",
        avatar_url: message.author.avatarURL() ?? undefined,
        files: message.attachments.map((a) => ({
          name: a.name,
          url: a.url,
        })),
        embeds: await Promise.all(
          message.embeds.map(
            async (x) => await discordEmbedToFluxer(x, fluxerClient),
          ),
        ),
      },
      true,
    );

    await MessageMap.create({
      messageSource: "discord",
      discordMessageId: msg?.id,
      fluxerMessageId: message.id,
      content: await parseDiscordEmojiToFluxer(message.content, fluxerClient),
      channelMapId: channelMap.id,
      authorId: message.author.id,
    });
  }
}

export async function DiscordUpdateMessageHandler(
  oldMsg: OmitPartialGroupDMChannel<
    DiscordMessage<boolean> | DiscordPartialMessage<boolean>
  >,
  newMsg: OmitPartialGroupDMChannel<DiscordMessage<boolean>>,
  client: FluxerClient,
) {
  const messageExisting = await MessageMap.findOne({
    where: {
      discordMessageId: newMsg.id,
    },
    include: ["channelMap"],
  });

  if (messageExisting) {
    const channelMap = messageExisting.channelMap;
    const channel = await client.channels.fetch(channelMap.fluxerChannelId);

    const message = await (channel as TextChannel).messages.fetch(
      messageExisting.fluxerMessageId,
    );

    const newAttachments = newMsg.attachments.filter((x) =>
      message.attachments.find((y) => y.url === x.url || y.url === x.proxyURL),
    );

    let messageReference: MessageMap | null;
    if (newMsg.reference) {
      messageReference = await MessageMap.findOne({
        where: {
          [Op.or]: [
            {
              discordMessageId: newMsg.reference.messageId,
            },
            {
              fluxerMessageId: newMsg.reference.messageId,
            },
          ],
        },
      });
    }

    console.log(newAttachments);
    await message.edit({
      content:
        // @ts-expect-error
        (messageReference
          ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> ${messageReference.messageSource === "fluxer" ? `<@${messageReference.authorId}>` : `@${(await newMsg.fetchReference()).author.tag}`} (https://fluxer.app/channels/${channelMap.fluxerGuildId}/${channelMap.fluxerChannelId}/${messageReference.fluxerMessageId}): ${truncate(messageReference.content, 25)}\n`
          : "") +
        (await parseDiscordEmojiToFluxer(message.content, client)) +
        (Array.from(newAttachments).length > 0
          ? `\n${Array.from(newAttachments).map((x, i) => `[${i}](${x})`)}`
          : ""),
      embeds: await Promise.all(
        newMsg.embeds.map(async (x) => await discordEmbedToFluxer(x, client)),
      ),
    });

    messageExisting.content = newMsg.content;
    await messageExisting.save();
  }
}

export async function DiscordDeleteMessageHandler(
  msg: OmitPartialGroupDMChannel<
    DiscordMessage<boolean> | DiscordPartialMessage<boolean>
  >,
  client: FluxerClient,
) {
  const messageExisting = await MessageMap.findOne({
    where: {
      discordMessageId: msg.id,
    },
    include: ["channelMap"],
  });

  console.log(messageExisting);

  if (messageExisting) {
    const channelMap = messageExisting.channelMap;
    const channel = await client.channels.fetch(channelMap.fluxerChannelId);

    const message = await (channel as TextChannel).messages.fetch(
      messageExisting.fluxerMessageId,
    );

    await message.delete();
    await messageExisting.destroy();
  }
}

async function checkManageServerPerms(
  guildId: string,
  userId: string,
  client: FluxerClient | DiscordClient,
) {
  const guild = await client.guilds.fetch(guildId);
  if (!guild) return false;
  const user = await guild.members.fetch({
    user: userId,
  });
  if (Array.isArray(user)) {
    return (
      user[0]?.permissions.has(PermissionFlags.ManageGuild) ||
      user[0]?.permissions.has(PermissionFlags.Administrator) ||
      guild.ownerId == userId
    );
  } else {
    return (
      user.permissions.has(DiscordPermissionFlagsBits.ManageGuild) ||
      user.permissions.has(DiscordPermissionFlagsBits.Administrator) ||
      guild.ownerId == user.id
    );
  }
}
