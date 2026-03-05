import { log } from "./Logger.js";
import RandomString from "./RandomString.js";
import Config from "../utils/ConfigHandler.js";
import { ChannelMap, MessageMap } from "../db/index.js";
import { Op } from "sequelize";

/**
 * @param {string | null} content
 * @param {FluxerClient} fluxerClient
 */
export async function parseDiscordEmojiToFluxer(content, fluxerClient) {
  if (!content) return content;
  const regex = /:(a?\d+):/g;

  let result = content.replace(/<(a?):[\w\-\_]+:(\d+)>/g, ":$1$2:");

  /** @type {string[]} */
  const emojis = [];

  let m;
  while ((m = regex.exec(result)) !== null) {
    if (m.index === regex.lastIndex) {
      regex.lastIndex++;
    }

    if (m[1]) {
      if (!emojis.includes(m[1])) {
        emojis.push(m[1]);
        try {
          const res = await fetch(
            "https://cdn.discordapp.com/emojis/" +
              m[1].replace("a", "") +
              (m[1].startsWith("a") ? ".gif" : ".webp"),
          );
          const buf = await res.arrayBuffer();
          const str = RandomString(16);

          const fluxerGuild = await fluxerClient.guilds.fetch(
            Config.FluxerTempEmojiGuildId,
          );
          await fluxerGuild?.createEmojisBulk([
            {
              image: btoa(
                new Uint8Array(buf).reduce(
                  (data, byte) => data + String.fromCharCode(byte),
                  "",
                ),
              ),
              name: str,
            },
          ]);

          const fluxerEmoji = await fluxerClient.resolveEmoji(
            `:${str}:`,
            Config.FluxerTempEmojiGuildId,
          );

          result = result.replaceAll(`:${m[1]}:`, `<${fluxerEmoji}>`);
        } catch (e) {
          log(
            "FLUXER",
            "Cannot convert Discord emoji to Fluxer, deleting 10 oldest emojis and trying again...",
            e,
          );
          await deleteOldestEmojisFluxer(fluxerClient);
          return await parseDiscordEmojiToFluxer(content, fluxerClient);
        }
      }
    }
  }

  return result;
}

/**
 * @param {string} content
 * @param {DiscordClient} discordClient
 */
export async function parseFluxerEmojiToDiscord(content, discordClient) {
  if (!content) return content;
  const regex = /:(a?\d+):/g;

  let result = content.replace(/<(a?):[\w\-\_]+:(\d+)>/g, ":$1$2:");

  /** @type {string[]} */
  const emojis = [];

  let m;
  while ((m = regex.exec(result)) !== null) {
    if (m.index === regex.lastIndex) {
      regex.lastIndex++;
    }

    if (m[1]) {
      if (!emojis.includes(m[1])) {
        emojis.push(m[1]);
        try {
          const res = await fetch(
            "https://fluxerusercontent.com/emojis/" +
              m[1].replace("a", "") +
              ".webp?animated=" +
              (m[1].startsWith("a") ? "true" : "false") +
              "&size=240&quality=lossless",
          );
          const arrBuf = await res.arrayBuffer();
          const buf = Buffer.from(arrBuf);
          const str = RandomString(16);

          const discordEmoji = await discordClient.application?.emojis.create({
            attachment: buf,
            name: str,
          });

          result = result.replaceAll(
            `:${m[1]}:`,
            `<${m[1].startsWith("a") ? "a" : ""}:${str}:${discordEmoji?.id}>`,
          );
        } catch (e) {
          log(
            "DISCORD",
            "Cannot convert Fluxer emoji to Discord, deleting 10 oldest emojis and trying again...",
            e,
          );
          await deleteOldestEmojisDiscord(discordClient);
          return await parseFluxerEmojiToDiscord(content, discordClient);
        }
      }
    }
  }

  return result;
}

/**
 * @param {string} str
 * @returns {string}
 */
export function removeLinkEmbeds(str) {
  const regex =
    /(https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(\([-a-zA-Z0-9@:%_+.~#?&/=]*\)|[-a-zA-Z0-9@:%_+.~#?&/=])*)/g;
  return str.replace(regex, "<$1>");
}

/**
 * @param {string} str
 * @param {import('discord.js').Client} discordClient
 * @param {import('@fluxerjs/core').Client} fluxerClient
 * @returns {Promise<string>}
 */
export async function traverseMessageLinks(str) {
  let result = str;

  const regex =
    /https:\/\/(discord.com|fluxer.app)\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/g;

  let m;
  while ((m = regex.exec(result)) !== null) {
    if (m.index === regex.lastIndex) {
      regex.lastIndex++;
    }

    try {
      if (m[1] && m[2] && m[3]) {
        if (m[4]) {
          const message = await MessageMap.findOne({
            where: {
              [Op.or]: {
                discordMessageId: m[4],
                fluxerMessageId: m[4],
              },
            },
            include: ["channelMap"],
          });
          if (message) {
            if (m[1].startsWith("fluxer")) {
              result = result.replaceAll(
                m[0],
                `https://discord.com/channels/${message.channelMap.discordGuildId}/${message.channelMap.discordChannelId}/${message.discordMessageId}`,
              );
            } else {
              result = result.replaceAll(
                m[0],
                `https://fluxer.app/channels/${message.channelMap.fluxerGuildId}/${message.channelMap.fluxerChannelId}/${message.fluxerMessageId}`,
              );
            }
          }
        } else {
          const channel = await ChannelMap.findOne({
            where: {
              [Op.or]: {
                discordChannelId: m[3],
                fluxerChannelId: m[3],
              },
            },
          });
          if (channel) {
            if (m[1].startsWith("fluxer")) {
              result = result.replaceAll(
                m[0],
                `https://discord.com/channels/${channel.discordGuildId}/${channel.discordChannelId}`,
              );
            } else {
              result = result.replaceAll(
                m[0],
                `https://fluxer.app/channels/${channel.fluxerGuildId}/${channel.fluxerChannelId}`,
              );
            }
          }
        }
      }
    } catch {}
  }

  return result;
}

/**
 * @param {FluxerClient} fluxerClient
 */
async function deleteOldestEmojisFluxer(fluxerClient) {
  const guild = await fluxerClient.guilds.fetch(Config.FluxerTempEmojiGuildId);
  if (guild) {
    let emojis = await guild.fetchEmojis();
    emojis = emojis.filter((x) => !x.name.startsWith("reply"));
    emojis = emojis.slice(-11, -1);

    await Promise.all(emojis.map(async (x) => await x.delete()));
  }
}

/**
 * @param {DiscordClient} discordClient
 */
async function deleteOldestEmojisDiscord(discordClient) {
  let app = await discordClient.application?.fetch();
  if (app) {
    let emojis = app.emojis.cache.filter((x) => !x.name.startsWith("reply"));
    let i = 0;
    for (let emojiKey in emojis.reverse().keys) {
      if (i > 10) break;
      const emoji = emojis.get(emojiKey);
      await emoji?.delete();
      i++;
    }
  }
}
