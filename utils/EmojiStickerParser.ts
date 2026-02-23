import {
  Client as FluxerClient,
  GuildSticker as FluxerSticker,
} from "@fluxerjs/core";
import {
  Client as DiscordClient,
  Sticker as DiscordSticker,
  Message,
} from "discord.js";
import { log } from "./Logger";
import RandomString from "./RandomString";
import Config from "../config";

export async function parseDiscordEmojiToFluxer(
  content: string | null,
  fluxerClient: FluxerClient,
) {
  if (!content) return content;
  const regex = /:(a?\d+):/g;

  let result = content.replace(/<(a?):[\w\-\_]+:(\d+)>/g, ":$1$2:");

  const emojis: string[] = [];

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
          const arr = new Uint8Array(buf);
          const str = RandomString(16);

          const fluxerGuild = await fluxerClient.guilds.fetch(
            Config.FluxerTempEmojiGuildId,
          );
          await fluxerGuild?.createEmojisBulk([
            {
              image: arr.toBase64(),
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

export async function parseFluxerEmojiToDiscord(
  content: string,
  discordClient: DiscordClient,
) {
  if (!content) return content;
  const regex = /:(a?\d+):/g;

  let result = content.replace(/<(a?):[\w\-\_]+:(\d+)>/g, ":$1$2:");

  const emojis: string[] = [];

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

async function deleteOldestEmojisFluxer(fluxerClient: FluxerClient) {
  const guild = await fluxerClient.guilds.fetch(Config.FluxerTempEmojiGuildId);
  if (guild) {
    let emojis = await guild.fetchEmojis();
    emojis = emojis.filter((x) => !x.name.startsWith("reply"));
    emojis = emojis.slice(-11, -1);

    await Promise.all(emojis.map(async (x) => await x.delete()));
  }
}

async function deleteOldestEmojisDiscord(discordClient: DiscordClient) {
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
