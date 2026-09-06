import { Client as FluxerClient } from "@fluxerjs/core";
import {
  ButtonStyle,
  ComponentType,
  Message,
  MessageMentions,
} from "discord.js";
import { ChannelMap } from "../db/index.js";
import { Op } from "sequelize";

/**
 * @param {import("discord.js").Message | import("@fluxerjs/core").Message} message
 * @param {string?} content
 */
export async function parseMentions(message, content) {
  let res = content || message.content;

  if (!res) return "";

  if (message.mentions instanceof MessageMentions) {
    const bridgedChannels = await ChannelMap.findAll({
      where: {
        discordChannelId: {
          [Op.in]: message.mentions.channels.map((x) => x.id),
        },
      },
    });

    message.mentions.channels.forEach((v) => {
      const bridgedChannel = bridgedChannels.find(
        (x) => v.id === x.discordChannelId,
      );
      if (!v.isDMBased())
        res = res.replaceAll(
          `<#${v.id}>`,
          bridgedChannel
            ? `<#${bridgedChannel.fluxerChannelId}>`
            : `#${v.name}`,
        );
    });

    message.mentions.users.forEach((v) => {
      res = res.replaceAll(`<@${v.id}>`, `@${v.tag}`);
    });

    message.mentions.roles.forEach((v) => {
      res = res.replaceAll(`<@&${v.id}>`, `@${v.name}`);
    });
  } else if (message.client instanceof FluxerClient) {
    res = await parseRolesAndChannels(
      res,
      message.guildId ?? "",
      message.client,
    );

    message.mentions.forEach((v) => {
      res = res.replaceAll(`<@${v.id}>`, `@${v.username}#${v.discriminator}`);
    });
  }

  return res;
}

/**
 * @param {string} content
 * @param {string} guildId
 * @param {FluxerClient} fluxerClient
 */
async function parseRolesAndChannels(content, guildId, fluxerClient) {
  let guild;
  try {
    guild = await fluxerClient.guilds.fetch(guildId);
  } catch {
    return content;
  }

  let res = content;

  if (guild) {
    const roles = await guild.fetchRoles();
    const channels = await guild.fetchChannels();

    roles.forEach((v) => {
      res = res.replaceAll(`<@&${v.id}>`, `@${v.name}`);
    });

    const bridgedChannels = await ChannelMap.findAll({
      where: {
        fluxerChannelId: {
          [Op.in]: channels.map((x) => x.id),
        },
      },
    });

    channels.forEach((v) => {
      const bridgedChannel = bridgedChannels.find(
        (x) => v.id === x.fluxerChannelId,
      );
      res = res.replaceAll(
        `<#${v.id}>`,
        bridgedChannel ? `<#${bridgedChannel.discordChannelId}>` : `#${v.name}`,
      );
    });
  }

  return res;
}

/**
 * @param {import("discord.js").Message | import("@fluxerjs/core").Message} message
 */
export async function attemptParseBridgedMessage(message) {
  const defaultResponse = {
    isBridge: false,
    isProxy: false,
    messageData: { parsedContent: message.content ?? "" },
    excludeEmbed: false,
  };

  if (!message.webhookId) return defaultResponse;

  const content = message.content ?? "";

  const contentParsers = [
    {
      type: "fluxcord",
      isBridge: true,
      isProxy: false,
      regex:
        /-# <:reply_l.*\(<https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)>\)\n?/,
    },
    {
      type: "ooye",
      isBridge: true,
      isProxy: false,
      regex:
        /-# > <:L1.*>https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+).*\n?/,
    },
    {
      type: "tupperbox",
      isBridge: false,
      isProxy: true,
      regex:
        /> \[Reply to\]\(<https:\/\/discord\.com\/channels\/((?:\d+|@me))\/(\d+)\/(\d+)>.+?\n>.*\n?/,
    },
  ];

  for (const parser of contentParsers) {
    const match = parser.regex.exec(content);
    if (match) {
      const [, guildId, channelId, messageId] = match;
      if (guildId && channelId && messageId) {
        return {
          isBridge: parser.isBridge,
          isProxy: parser.isProxy,
          type: parser.type,
          messageData: {
            guildId,
            channelId,
            messageId,
            parsedContent: content.replace(parser.regex, ""),
          },
          excludeEmbed: false,
        };
      }
    }
  }

  const pluralkitReplyRegex =
    /\*\*\[Reply to:\]\(https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;

  if (Array.isArray(message.embeds)) {
    for (const [i, embed] of message.embeds.entries()) {
      if (!embed.description) continue;

      const match = pluralkitReplyRegex.exec(embed.description);
      if (match) {
        const [, guildId, channelId, messageId] = match;
        if (guildId && channelId && messageId) {
          return {
            isBridge: false,
            isProxy: true,
            type: "pluralkit",
            messageData: {
              guildId,
              channelId,
              messageId,
              parsedContent: content,
            },
            excludeEmbed: i,
          };
        }
      }
    }
  }

  const boltReplyRegex =
    /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;

  if (Array.isArray(message.components)) {
    for (const row of message.components) {
      const isActionRow =
        row.type === 1 ||
        row.type === "ActionRow" ||
        row.type === ComponentType?.ActionRow;
      if (!isActionRow || !row.components?.length) continue;

      const firstBtn = row.components[0];
      const isLinkButton =
        (firstBtn.type === 2 || firstBtn.type === "Button") &&
        (firstBtn.style === 5 || firstBtn.style === ButtonStyle?.Link);

      if (isLinkButton && firstBtn.url) {
        const match = boltReplyRegex.exec(firstBtn.url);
        if (match) {
          const [, guildId, channelId, messageId] = match;
          if (guildId && channelId && messageId) {
            return {
              isBridge: true,
              isProxy: false,
              type: "bolt",
              messageData: {
                guildId,
                channelId,
                messageId,
                parsedContent: content,
              },
              excludeEmbed: false,
            };
          }
        }
      }
    }
  }

  return defaultResponse;
}
