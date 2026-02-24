import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
  type PartialMessage as DiscordPartialMessage,
  MessageType,
  type ReadonlyCollection,
  Message,
  type PartialMessage,
  Typing,
  type TextBasedChannel,
  MessageFlags,
  MessageFlagsBitField,
} from "discord.js";
import {
  Client as FluxerClient,
  GuildChannel as FluxerGuildChannel,
  GuildChannel,
  TextChannel,
} from "@fluxerjs/core";
import { ChannelMap, MessageMap, sequelize, UserConfig } from "../db";
import Config from "../config";
import { CommandHandler } from "./CommandHandler";
import { log } from "./Logger";
import { Op } from "sequelize";
import truncate from "truncate";
import { readFileSync } from "node:fs";
import { discordEmbedToFluxer } from "./EmbedConverter";
import { parseDiscordEmojiToFluxer } from "./EmojiStickerParser";
import { checkManageServerPerms } from "./CheckManageServerPerms";
import { parseMentions } from "./MessageContentParser";

let fluxcordBotEmojiCfg: any = undefined;

export async function DiscordCreateMessageHandler(
  message: OmitPartialGroupDMChannel<DiscordMessage<boolean>>,
  client: DiscordClient,
  fluxerClient: FluxerClient,
  proxyCompatibility?: boolean,
) {
  if (!fluxcordBotEmojiCfg)
    fluxcordBotEmojiCfg = JSON.parse(
      readFileSync(Config.DataFolderPath + "/fluxcord.json", "utf-8"),
    );

  if (!message.guildId || message.type === MessageType.ChannelPinnedMessage)
    return;
  if (message.content.startsWith(Config.BotPrefix)) {
    CommandHandler(message, client, fluxerClient);
    return;
  }

  const userConfig = await UserConfig.findOne({
    where: {
      userId: message.author.id,
    },
  });
  if (
    ((userConfig && userConfig.proxyCompatibility) ||
      (message.type === MessageType.ChatInputCommand &&
        message.flags.has("Loading"))) &&
    (!proxyCompatibility || message.flags.has("Loading"))
  ) {
    setTimeout(
      async () =>
        await DiscordCreateMessageHandler(message, client, fluxerClient, true),
      3000,
    );
    return;
  }

  if (proxyCompatibility && message.type !== MessageType.ChatInputCommand) {
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

  const stickers = message.stickers.map((x) => `${x.name}`);

  const stickerMsg =
    stickers.length > 0
      ? `\n-# Message contains stickers: ${stickers.join(", ")}`
      : "";

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
  const userJoin =
    message.type === MessageType.UserJoin
      ? `*@${message.author.tag} joined the bridged server*`
      : "";
  const channel = await fluxerClient.channels.fetch(channelMap.fluxerChannelId);
  const webhooks = await (channel as FluxerGuildChannel).fetchWebhooks();
  const webhook = webhooks.find((x) => x.id === channelMap.fluxerWebhookId);
  const overAttachments = message.attachments.filter((x) => x.size > 24999900);
  const overAttachmentsStr = overAttachments
    .map((x) => `[${x.name}](${x.url})`)
    .join(" ");
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
          (await parseDiscordEmojiToFluxer(
            await parseMentions(message),
            fluxerClient,
          )) +
          stickerMsg +
          userJoin +
          (overAttachmentsStr
            ? "\n-# has attachments over 25mb: " + overAttachmentsStr
            : ""),
        username:
          message.author.displayName ?? message.author.globalName ?? "Fluxcord",
        avatar_url: message.author.avatarURL() ?? undefined,
        files: message.attachments
          .filter((x) => x.size < 24999900)
          .map((a) => ({
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
      discordMessageId: message.id,
      fluxerMessageId: msg?.id,
      content: await parseDiscordEmojiToFluxer(
        await parseMentions(message),
        fluxerClient,
      ),
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

    await message.edit({
      content:
        // @ts-expect-error
        (messageReference
          ? `-# <${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyL}><${fluxcordBotEmojiCfg.fluxerReplyEmoji.replyR}> ${messageReference.messageSource === "fluxer" ? `<@${messageReference.authorId}>` : `@${(await newMsg.fetchReference()).author.tag}`} (https://fluxer.app/channels/${channelMap.fluxerGuildId}/${channelMap.fluxerChannelId}/${messageReference.fluxerMessageId}): ${truncate(messageReference.content, 25)}\n`
          : "") +
        (await parseDiscordEmojiToFluxer(
          await parseMentions(message),
          client,
        )) +
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

export async function DiscordBulkDeleteMessageHandler(
  msgs: ReadonlyCollection<string, Message<true> | PartialMessage<true>>,
  client: FluxerClient,
) {
  const messagesExisting = await MessageMap.findAll({
    where: {
      discordMessageId: {
        [Op.in]: msgs.map((x) => x.id),
      },
    },
    include: ["channelMap"],
  });

  if (messagesExisting.length > 0) {
    const channel = (await client.channels.fetch(
      messagesExisting[0]?.channelMap.fluxerChannelId ?? "",
    )) as GuildChannel;

    const reply = await channel.send({
      content: `Bridging bulk deletes, please wait...`,
    });

    await channel.bulkDeleteMessages(
      messagesExisting.map((x) => x.fluxerMessageId),
    );

    await Promise.all(messagesExisting.map(async (x) => await x.destroy()));

    await reply.delete();
  }
}

export async function DiscordPinsUpdateHandler(
  channel: TextBasedChannel,
  client: FluxerClient,
) {
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

    const fluxerChannel = (await client.channels.fetch(
      channelMap?.fluxerChannelId,
    )) as TextChannel;

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
