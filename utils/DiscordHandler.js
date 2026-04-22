import { MessageFlags, MessageType } from "discord.js";
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
import { parseMentions } from "./MessageContentParser.js";
import { sanitizePings } from "./SanitizePings.js";
import { sendErrorMessage } from "./SendErrorMessage.js";

let fluxcordBotEmojiCfg = undefined;

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean>>} message
 * @param {DiscordClient} client
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export async function DiscordCreateMessageHandler(
  message,
  client,
  fluxerClient,
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

  const userOptOut = await UserConfig.findOne({
    where: {
      userType: "discord",
      userId: message.author.id,
      doNotBridgePrefix: "__opted_out__",
    },
  });

  if (userOptOut) return;

  const channelMapViaUserId = await ChannelMap.findOne({
    where: {
      [Op.or]: {
        discordWebhookId: message.author.id,
        fluxerWebhookId: message.author.id,
      },
    },
  });

  if (channelMapViaUserId) return;

  const isLoadingInteraction =
    message.type === MessageType.ChatInputCommand &&
    message.flags.has("Loading");

  if (isLoadingInteraction) {
    setTimeout(async () => {
      try {
        await DiscordCreateMessageHandler(message, client, fluxerClient);
      } catch (e) {
        await sendErrorMessage(message, client, fluxerClient, e);
      }
    }, 5000);
    return;
  }

  const stickers = message.stickers.map((x) => `${x.name}`);

  let stickerMsg = "";

  if (message.stickers.find((x) => x.url.endsWith("json")))
    stickerMsg =
      stickers.length > 0
        ? `-# Message contains stickers: ${stickers.join(", ")}`
        : "";
  else
    stickerMsg =
      stickers.length > 0
        ? `${message.stickers.map((x) => `[${x.name}](${x.url})`).join(", ")}`
        : "";

  const channelMap = await ChannelMap.findOne({
    where: {
      discordChannelId: message.channelId,
    },
    raw: true,
  });

  if (channelMap?.bridgeType === "fluxer2discord") return;

  if (!channelMap || channelMap.discordWebhookId === message.webhookId) return;

  let forwardedMessage;
  if (message.reference?.type === 1) {
    forwardedMessage = message.messageSnapshots.first();
  }

  /** @type {import("../db/models/MessageMap.js").MessageMap | null} */
  let messageReference;
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
  const webhooks = await /** @type {FluxerGuildChannel} */ (
    channel
  ).fetchWebhooks();
  const webhook = webhooks.find((x) => x.id === channelMap.fluxerWebhookId);
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
    } catch {}

    const parsedContent = await traverseMessageLinks(
      await parseDiscordEmojiToFluxer(
        sanitizePings(await parseMentions(forwardedMessage ?? message)),
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
        : "");
    parsedContent +
      stickerMsg +
      userJoin +
      (overAttachmentsStr
        ? "\n-# has attachments over 25mb: " + overAttachmentsStr
        : "");
    const webhookUsername =
      guildUser?.displayName ??
      message.author.displayName ??
      message.author.globalName ??
      "Fluxcord";
    const webhookFiles = (forwardedMessage ?? message).attachments
      .filter((x) => x.size < 24999900)
      .map((a) => ({ name: a.name, url: a.url }));
    const webhookEmbeds = await Promise.all(
      (forwardedMessage ?? message).embeds.map(
        async (x) => await discordEmbedToFluxer(x, fluxerClient),
      ),
    );

    let msg;
    if (messageReferenceOption) {
      msg = await fluxerClient.rest.post(
        `/webhooks/${channelMap.fluxerWebhookId}/${channelMap.fluxerWebhookToken}?wait=true`,
        {
          body: {
            content: webhookContent,
            username: webhookUsername,
            avatar_url: message.author.avatarURL() ?? undefined,
            embeds: webhookEmbeds,
            files: webhookFiles,
            message_reference: messageReferenceOption,
          },
          auth: false,
        },
      );
    } else {
      msg = await webhook.send(
        {
          content: webhookContent,
          username: webhookUsername,
          avatar_url: message.author.avatarURL() ?? undefined,
          files: webhookFiles,
          embeds: webhookEmbeds,
        },
        true,
      );
    }

    setTimeout(async () => {
      try {
        const channel = await message.channel.fetch();
        if (channel.isSendable()) {
          await channel.messages.fetch(message.id);
        }

        await MessageMap.create({
          messageSource: "discord",
          discordMessageId: message.id,
          fluxerMessageId: msg?.id,
          fluxerReplyId: messageReference?.fluxerMessageId ?? null,
          discordReplyId: message.reference?.messageId ?? null,
          content: parsedContent,
          channelMapId: channelMap.id,
          authorId: message.author.id,
        });
      } catch {
        // pretend msg is deleted
        try {
          const fluxerChannel = await fluxerClient.channels.fetch(
            channelMap.fluxerChannelId,
          );
          if (fluxerChannel.isTextBased()) {
            const message = await fluxerChannel.messages.fetch(msg?.id ?? "");
            await message.delete();
          }
        } catch {}
      }
    }, 1000);
  }
}

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<DiscordMessage<boolean> | import("discord.js").PartialMessage<boolean>>} oldMsg
 * @param {import("discord.js").OmitPartialGroupDMChannel<DiscordMessage<boolean>>} newMsg
 * @param {FluxerClient} client
 */
export async function DiscordUpdateMessageHandler(oldMsg, newMsg, client) {
  const userOptOut = await UserConfig.findOne({
    where: {
      userType: "discord",
      userId: newMsg.author.id,
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
        discordWebhookId: newMsg.author.id,
        fluxerWebhookId: newMsg.author.id,
      },
    },
  });

  if (channelMapViaUserId) return;

  if (messageExisting) {
    const channelMap = messageExisting.channelMap;

    const newContent = await traverseMessageLinks(
      await parseDiscordEmojiToFluxer(
        sanitizePings(await parseMentions(newMsg)),
        client,
        channelMap.fluxerGuildId,
      ),
    );

    await client.rest.patch(
      `/webhooks/${channelMap.fluxerWebhookId}/${channelMap.fluxerWebhookToken}/messages/${messageExisting.fluxerMessageId}`,
      {
        body: {
          content: newContent,
          embeds: await Promise.all(
            newMsg.embeds.map(
              async (x) => await discordEmbedToFluxer(x, client),
            ),
          ),
        },
        auth: false,
      },
    );

    messageExisting.content = await traverseMessageLinks(
      await parseDiscordEmojiToFluxer(
        sanitizePings(await parseMentions(newMsg)),
        client,
        channelMap.fluxerGuildId,
      ),
    );
    await messageExisting.save();
  }
}

/**
 * @param {import("discord.js").OmitPartialGroupDMChannel<DiscordMessage<boolean> | import("discord.js").PartialMessage<boolean>>} msg
 * @param {FluxerClient} client
 */
export async function DiscordDeleteMessageHandler(msg, client) {
  const messageExisting = await MessageMap.findOne({
    where: {
      discordMessageId: msg.id,
    },
    include: ["channelMap"],
  });

  if (messageExisting) {
    const channelMap = messageExisting.channelMap;
    const channel = await client.channels.fetch(channelMap.fluxerChannelId);

    try {
      const message = await /** @type {TextChannel} */ (channel).messages.fetch(
        messageExisting.fluxerMessageId,
      );
      await message.delete();
    } catch {}
    await messageExisting.destroy();
  }
}

/**
 * @param {import("discord.js").ReadonlyCollection<string, Message<true> | import("discord.js").PartialMessage<true>>} msgs
 * @param {FluxerClient} client
 */
export async function DiscordBulkDeleteMessageHandler(msgs, client) {
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

    await channel.bulkDeleteMessages(
      messagesExisting.map((x) => x.fluxerMessageId),
    );

    await Promise.all(messagesExisting.map(async (x) => await x.destroy()));

    await reply.delete();
  }
}

/**
 * @param {import("discord.js").TextBasedChannel} channel
 * @param {FluxerClient} client
 */
export async function DiscordPinsUpdateHandler(channel, client) {
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
