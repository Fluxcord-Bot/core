import { log } from "./Logger.js";
import RandomString from "./RandomString.js";
import Config from "../utils/ConfigHandler.js";

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
