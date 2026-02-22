import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
  type PartialMessage as DiscordPartialMessage,
} from "discord.js";
import {
  Client as FluxerClient,
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
import { parseDiscordEmojiToFluxer } from "./EmojiStickerParser";
import { checkManageServerPerms } from "./CheckManageServerPerms";

let fluxcordBotEmojiCfg: any = undefined;

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
    CommandHandler(message, client, fluxerClient);
    return;
  }

  const stickers = message.stickers
    .map((x) => `[${x.name}](${x.url})`)
    .join(" ");

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
          (await parseDiscordEmojiToFluxer(message.content, fluxerClient)) +
          stickers,
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
