//@ts-check
import { Events as DiscordEvents, Routes as DiscordRoutes } from "discord.js";
import { Events as FluxerEvents, Routes as FluxerRoutes } from "@fluxerjs/core";
import { ChannelMap, MessageMap } from "../db/index.js";
import { log } from "./Logger.js";
import Config from "./ConfigHandler.js";
import {
  getFluxEmojis,
  getDiscordEmojis,
  getBotEmojis,
  clearFluxEmojiCache,
  clearBotEmojiCache,
} from "./EmojiCache.js";

/**
 * Upload a Discord custom emoji to the Fluxer temp guild (or find existing).
 * Return "storeName:fluxerEmojiId" || null on failure
 * 
 * @param {string} discordEmojiId
 * @param {boolean} animated
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {string} targetFluxerGuildId
 * @param {string | null} emojiName
 */
async function mirrorDiscordEmojiToFluxer(discordEmojiId, animated, fluxerClient, targetFluxerGuildId, emojiName) {
  if (emojiName) {
    try {
      const targetEmojis = await getFluxEmojis(targetFluxerGuildId, fluxerClient);
      const byName = targetEmojis.find((x) => x.name === emojiName);
      if (byName) return `${byName.name}:${byName.id}`;
    } catch { }
  }

  const storeName = `e${animated ? "a" : ""}${discordEmojiId}`;
  try {
    let emojis = await getFluxEmojis(Config.FluxerTempEmojiGuildId, fluxerClient);
    let existing = emojis.find((x) => x.name === storeName);

    if (!existing) {
      const res = await fetch(
        `https://cdn.discordapp.com/emojis/${discordEmojiId}${animated ? ".gif" : ".webp"}`,
      );
      const buf = await res.arrayBuffer();
      const guild = await fluxerClient.guilds.fetch(Config.FluxerTempEmojiGuildId);
      await guild?.createEmojisBulk([{
        image: btoa(new Uint8Array(buf).reduce((d, b) => d + String.fromCharCode(b), "")),
        name: storeName,
      }]);
      clearFluxEmojiCache(Config.FluxerTempEmojiGuildId);
      emojis = await getFluxEmojis(Config.FluxerTempEmojiGuildId, fluxerClient);
      existing = emojis.find((x) => x.name === storeName);
    }

    if (!existing?.id) return null;
    return `${storeName}:${existing.id}`;
  } catch (e) {
    log("FLUXER", `Failed to mirror Discord emoji ${discordEmojiId} to Fluxer: ${e}`);
    return null;
  }
}

/**
 * Upload a Fluxer custom emoji to Discord app emojis (or find existing).
 * Return "storeName:discordEmojiId" || null on failure.
 * 
 * @param {string} fluxerEmojiId
 * @param {boolean} animated
 * @param {import("discord.js").Client} discordClient
 * @param {string} targetDiscordGuildId
 * @param {string | null} emojiName
 */
async function mirrorFluxerEmojiToDiscord(fluxerEmojiId, animated, discordClient, targetDiscordGuildId, emojiName) {
  if (emojiName) {
    try {
      const targetEmojis = await getDiscordEmojis(targetDiscordGuildId, discordClient);
      const byName = targetEmojis.find((x) => x.name === emojiName);
      if (byName) return `${byName.name}:${byName.id}`;
    } catch { }
  }

  const storeName = `e${animated ? "a" : ""}${fluxerEmojiId}`;
  try {
    const appEmojis = await getBotEmojis(discordClient);
    let existing = [...appEmojis.values()].find((x) => x.name === storeName);

    if (!existing) {
      const res = await fetch(
        `https://fluxerusercontent.com/emojis/${fluxerEmojiId}.webp?animated=${animated ? "true" : "false"}&size=240&quality=lossless`,
      );
      const buf = Buffer.from(await res.arrayBuffer());
      existing = await discordClient.application?.emojis.create({
        attachment: buf,
        name: storeName,
      });
      clearBotEmojiCache();
    }

    if (!existing?.id) return null;
    return `${storeName}:${existing.id}`;
  } catch (e) {
    log("DISCORD", `Failed to mirror Fluxer emoji ${fluxerEmojiId} to Discord: ${e}`);
    return null;
  }
}

/**
 * @param {import("discord.js").MessageReaction | import("discord.js").PartialMessageReaction} reaction reaction object from Discord event
 * @param {import("discord.js").User | import("discord.js").PartialUser} user User to protect against self-reaction loop
 * @param {"add" | "remove"} action whether this is an add or remove event
 * @param {import("@fluxerjs/core").Client} fluxerClient target fluxer instance
 */
async function relayDiscordReaction(reaction, user, action, fluxerClient) {
  if (user.bot) return;

  const messageMap = await MessageMap.findOne({
    where: { discordMessageId: reaction.message.id },
    include: ["channelMap"],
  });

  if (!messageMap) return;
  const channelMap = messageMap.channelMap;

  // Only relay Discord→Fluxer for bridges that include that direction
  if (channelMap.bridgeType === "fluxer2discord") return;

  const emoji = reaction.emoji;
  let emojiStr;

  if (!emoji.id) {
    // Unicode emoji — use as-is
    emojiStr = emoji.name;
  } else {
    // Custom emoji
    emojiStr = await mirrorDiscordEmojiToFluxer(emoji.id, emoji.animated ?? false, fluxerClient, channelMap.fluxerGuildId, emoji.name);
  }

  if (!emojiStr) return;

  const route = `${FluxerRoutes.channelMessageReaction(
    channelMap.fluxerChannelId,
    messageMap.fluxerMessageId,
    emojiStr,
  )}/@me`;

  if (action === "add") {
    await fluxerClient.rest.put(route);
  } else {
    await fluxerClient.rest.delete(route);
  }
}

/**
 * @param {import("@fluxerjs/core").MessageReaction} reaction reaction object from Fluxer event
 * @param {any} user User to protect against self-reaction loop
 * @param {"add" | "remove"} action whether this is an add or remove event
 * @param {import("discord.js").Client} discordClient target discord instance
 * @param {import("@fluxerjs/core").Client} fluxerClient source fluxer instance
 */
async function relayFluxerReaction(reaction, user, action, discordClient, fluxerClient) {
  if (user?.id === fluxerClient.user?.id) return;

  const messageMap = await MessageMap.findOne({
    where: { fluxerMessageId: reaction.messageId },
    include: ["channelMap"],
  });

  if (!messageMap) return;
  const channelMap = messageMap.channelMap;

  if (channelMap.bridgeType === "discord2fluxer") return;

  const emoji = reaction.emoji;
  let emojiStr;

  if (!emoji.id) {
    emojiStr = emoji.name;
  } else {
    emojiStr = await mirrorFluxerEmojiToDiscord(emoji.id, emoji.animated ?? false, discordClient, channelMap.discordGuildId, emoji.name);
  }

  if (!emojiStr) return;

  const route = `${DiscordRoutes.channelMessageReaction(
    channelMap.discordChannelId,
    messageMap.discordMessageId,
    emojiStr,
  )}/@me`;

  if (action === "add") {
    await discordClient.rest.put(route);
  } else {
    await discordClient.rest.delete(route);
  }
}

/**
 * Register reaction relay handlers on both clients.
 * @param {import("discord.js").Client} discordClient discord instance 
 * @param {import("@fluxerjs/core").Client} fluxerClient fluxer instance
 */
export function setupReactionHandling(discordClient, fluxerClient) {
  discordClient.on(DiscordEvents.MessageReactionAdd, (reaction, user) => {
    relayDiscordReaction(reaction, user, "add", fluxerClient).catch((e) =>
      log("FLUXER", `Discord→Fluxer reaction relay failed: ${e}`)
    );
  });

  discordClient.on(DiscordEvents.MessageReactionRemove, (reaction, user) => {
    relayDiscordReaction(reaction, user, "remove", fluxerClient).catch((e) =>
      log("FLUXER", `Discord→Fluxer reaction remove relay failed: ${e}`)
    );
  });

  fluxerClient.on(FluxerEvents.MessageReactionAdd, (reaction, user) => {
    relayFluxerReaction(reaction, user, "add", discordClient, fluxerClient).catch((e) =>
      log("DISCORD", `Fluxer→Discord reaction relay failed: ${e}`)
    );
  });

  fluxerClient.on(FluxerEvents.MessageReactionRemove, (reaction, user) => {
    relayFluxerReaction(reaction, user, "remove", discordClient, fluxerClient).catch((e) =>
      log("DISCORD", `Fluxer→Discord reaction remove relay failed: ${e}`)
    );
  });
}
