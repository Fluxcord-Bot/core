import { Client as FluxerClient } from "@fluxerjs/core";
import { ButtonStyle, ComponentType, Message, MessageMentions } from "discord.js";
import { BridgeEndpoint } from "../db/index.js";
import { Op } from "sequelize";

const FLUXER_GUILD_CACHE_TTL = 60_000;
const fluxerGuildCache = new Map();

function getFluxerGuildCacheEntry(guildId) {
  const cached = fluxerGuildCache.get(guildId);
  if (cached && Date.now() - cached.at < FLUXER_GUILD_CACHE_TTL) return cached;
  const entry = { at: Date.now() };
  fluxerGuildCache.set(guildId, entry);
  return entry;
}

async function getFluxerGuildRoles(guild) {
  const entry = getFluxerGuildCacheEntry(guild.id);
  if (!entry.roles) entry.roles = guild.roles.size > 0 ? guild.roles : await guild.fetchRoles();
  return entry.roles;
}

async function getFluxerGuildChannels(guild) {
  const entry = getFluxerGuildCacheEntry(guild.id);
  if (!entry.channels) entry.channels = guild.channels.size > 0 ? guild.channels : await guild.fetchChannels();
  return entry.channels;
}

const crossSideCache = new Map();
const CROSS_SIDE_TTL = 60_000;

function cachedCrossSide(key) {
  const cached = crossSideCache.get(key);
  if (cached && Date.now() - cached.at < CROSS_SIDE_TTL) return cached.id;
  return undefined;
}

/**
 * @param {"discord" | "fluxer"} sourcePlatform
 * @param {string} sourceChannelId
 * @param {"discord" | "fluxer"} targetPlatform
 * @returns {Promise<string | null>} target channel id through any bridge group, null when unbridged
 */
export async function crossSideChannelId(sourcePlatform, sourceChannelId, targetPlatform) {
  const cacheKey = `${sourcePlatform}:${sourceChannelId}:${targetPlatform}`;
  const cached = cachedCrossSide(cacheKey);
  if (cached !== undefined) return cached;

  const own = await BridgeEndpoint.findAll({
    where: { platform: sourcePlatform, channelId: sourceChannelId },
    attributes: ["groupId"],
    raw: true,
  });
  const groupIds = [...new Set(own.map(e => e.groupId))];
  if (groupIds.length === 0) {
    crossSideCache.set(cacheKey, { at: Date.now(), id: null });
    return null;
  }

  const rows = await BridgeEndpoint.findAll({
    where: { groupId: { [Op.in]: groupIds }, platform: targetPlatform },
    raw: true,
  });
  const id = rows[0]?.channelId ?? null;
  crossSideCache.set(cacheKey, { at: Date.now(), id });
  return id;
}

/**
 * @param {import("discord.js").Message | import("@fluxerjs/core").Message} message
 * @param {string | null} content
 * @param {import("discord.js").Guild | import("@fluxerjs/core").Guild | null} otherSideGuild
 * @returns {Promise<string>}
 */
export async function parseMentions(message, content, otherSideGuild, targetPlatform = "discord") {
  let res = content || message.content;

  if (!res) return "";

  if (message.mentions instanceof MessageMentions) {
    for (const v of message.mentions.channels.values()) {
      if (v.isDMBased()) continue;
      const mapped = await crossSideChannelId("discord", v.id, "fluxer");
      res = res.replaceAll(`<#${v.id}>`, mapped ? `<#${mapped}>` : `#${v.name}`);
    }

    message.mentions.users.forEach(v => {
      res = res.replaceAll(`<@${v.id}>`, `@${v.tag}`);
    });

    const whitelist = [];

    const roles = await getFluxerGuildRoles(otherSideGuild);
    message.mentions.roles.forEach(v => {
      res = res.replaceAll(
        `<@&${v.id}>`,
        (() => {
          if (!roles) return `@${v.name}`;
          const extRole = roles.find(x => x.name === v.name);
          if (!extRole) return `@${v.name}`;
          whitelist.push(extRole.id);
          return `<@&${extRole.id}>`;
        })()
      );
    });

    res = res.replace(/<@&(\d+)>/g, (match, id) => {
      return whitelist.includes(id) ? match : "@unknown-role";
    });
  } else if (message.client instanceof FluxerClient) {
    res = await parseRolesAndChannels(res, message.guildId ?? "", message.client, otherSideGuild, message, targetPlatform);

    message.mentions.forEach(v => {
      res = res.replaceAll(`<@${v.id}>`, `@${v.username}#${v.discriminator}`);
    });
  }

  return res;
}

async function parseRolesAndChannels(content, guildId, fluxerClient, otherSideGuild, message, targetPlatform = "discord") {
  let guild;
  try {
    guild = await fluxerClient.guilds.fetch(guildId);
  } catch {
    return content;
  }

  let res = content;

  if (guild) {
    const roles = await getFluxerGuildRoles(guild);
    const channels = await getFluxerGuildChannels(guild);
    const otherRoles = otherSideGuild.roles.cache.size > 0 ? otherSideGuild.roles.cache : await otherSideGuild.roles.fetch();
    const whitelist = [];

    roles.forEach(v => {
      res = res.replaceAll(
        `<@&${v.id}>`,
        (() => {
          if (!message.mentionRoles.includes(v.id)) return `@${v.name}`;
          if (!otherRoles) return `@${v.name}`;
          const extRole = otherRoles.find(x => x.name === v.name);
          if (!extRole) return `@${v.name}`;
          whitelist.push(extRole.id);
          return `<@&${extRole.id}>`;
        })()
      );
    });

    res = res.replace(/<@&(\d+)>/g, (match, id) => {
      return whitelist.includes(id) ? match : "@unknown-role";
    });

    for (const v of channels.values()) {
      const mapped = await crossSideChannelId("fluxer", v.id, targetPlatform);
      res = res.replaceAll(`<#${v.id}>`, mapped ? `<#${mapped}>` : `#${v.name}`);
    }
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
      regex: /-# <:reply_l.*\(<https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)>\)\n?/,
    },
    {
      type: "ooye",
      isBridge: true,
      isProxy: false,
      regex: /-# > <:L1.*>https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+).*\n?/,
    },
    {
      type: "tupperbox",
      isBridge: false,
      isProxy: true,
      regex: /> \[Reply to\]\(<https:\/\/discord\.com\/channels\/((?:\d+|@me))\/(\d+)\/(\d+)>.+?\n>.*\n?/,
    },
    {
      type: "kuma",
      isBridge: true,
      isProxy: false,
      regex: /-# ↩ \[.*\]\(<https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)\).*\n?/,
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

  const pluralkitReplyRegex = /.*https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+).*/;

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

  const boltReplyRegex = /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;

  if (Array.isArray(message.components)) {
    for (const row of message.components) {
      const isActionRow = row.type === 1 || row.type === "ActionRow" || row.type === ComponentType?.ActionRow;
      if (!isActionRow || !row.components?.length) continue;

      const firstBtn = row.components[0];
      const isLinkButton =
        (firstBtn.type === 2 || firstBtn.type === "Button") && (firstBtn.style === 5 || firstBtn.style === ButtonStyle?.Link);

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
