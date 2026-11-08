import ExpiryMap from "expiry-map";
import { Events as DiscordEvents, Routes as DiscordRoutes } from "discord.js";
import { Events as FluxerEvents, Routes as FluxerRoutes } from "@fluxerjs/core";
import { MessageMap } from "../db/index.js";
import { log } from "./Logger.js";
import { getFluxEmojis, getDiscordEmojis, getBotEmojis } from "./EmojiCache.js";
import { DEFAULT_INFO_EMOJI, getInfoReactionEmoji, isInfoReactionEmoji, sendBridgeInfo } from "./MessageBridgeInfo.js";
import {
  ensureFluxerEmojis,
  ensureDiscordEmojis,
  isFluxerEmojiRateLimited,
  isDiscordEmojiRateLimited,
} from "./EmojiStickerParser.js";
import { isFluxerRateLimitError, withFluxerRateLimit } from "./FluxerRateLimit.js";

const FLUX_EMOJI_META_TTL = 10 * 60 * 1000;

/** @type {ExpiryMap<string, { name: string, animated: boolean }>} */
const fluxEmojiMeta = new ExpiryMap(FLUX_EMOJI_META_TTL);

/**
 * @param {string} emojiId
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
async function getFluxEmojiMeta(emojiId, fluxerClient) {
  const cached = fluxEmojiMeta.get(emojiId);
  if (cached) return cached;
  const meta = await withFluxerRateLimit(() => fluxerClient.fetchEmojiMetadata(emojiId), `emoji-meta:${emojiId}`);
  fluxEmojiMeta.set(emojiId, meta);
  return meta;
}

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
  if (isFluxerEmojiRateLimited()) return null;
  if (emojiName) {
    try {
      const targetEmojis = await getFluxEmojis(targetFluxerGuildId, fluxerClient);
      const byName = targetEmojis.find(x => x.name === emojiName);
      if (byName) return `${byName.name}:${byName.id}`;
    } catch {}
  }

  const originId = emojiName?.match(/^ea?(\d{17,19})$/)?.[1] ?? null;
  if (originId) {
    try {
      const meta = await getFluxEmojiMeta(originId, fluxerClient);
      if (meta?.name) return `${meta.name}:${originId}`;
    } catch {}
    return `${emojiName}:${originId}`;
  }

  const token = `${animated ? "a" : ""}${discordEmojiId}`;
  const ensured = await ensureFluxerEmojis(fluxerClient, [token]);
  const emoji = ensured.get(token);
  return emoji?.id ? `${emoji.name}:${emoji.id}` : null;
}

/**
 * Upload a Fluxer custom emoji to Discord app emojis (or find existing).
 * Return "storeName:discordEmojiId" || null on failure.
 *
 * @param {string} fluxerEmojiId
 * @param {boolean | undefined} animated
 * @param {import("discord.js").Client} discordClient
 * @param {string} targetDiscordGuildId
 * @param {string | null} emojiName
 */
async function mirrorFluxerEmojiToDiscord(fluxerEmojiId, animated, discordClient, targetDiscordGuildId, emojiName) {
  if (isDiscordEmojiRateLimited()) return null;
  if (emojiName) {
    try {
      const targetEmojis = await getDiscordEmojis(targetDiscordGuildId, discordClient);
      const byName = targetEmojis.find(x => x.name === emojiName);
      if (byName) return `${byName.name}:${byName.id}`;
    } catch {}
  }

  const originId = emojiName?.match(/^ea?(\d{17,19})$/)?.[1] ?? null;
  if (originId) return `${emojiName}:${originId}`;

  if (animated === undefined) {
    try {
      const appEmojis = await getBotEmojis(discordClient);
      animated = [...appEmojis.values()].some(x => x.name === `ea${fluxerEmojiId}`);
    } catch {
      animated = false;
    }
  }

  const token = `${animated ? "a" : ""}${fluxerEmojiId}`;
  const ensured = await ensureDiscordEmojis(discordClient, [token]);
  const emoji = ensured.get(token);
  return emoji?.id ? `${emoji.name}:${emoji.id}` : null;
}

const REACTION_STATE_TTL = 12 * 60 * 60 * 1000;

/**
 * @type {ExpiryMap<string, { users: Set<string>, seeded: boolean, ready: Promise<void> | null }>}
 */
const reactionState = new ExpiryMap(REACTION_STATE_TTL);

function reactionStateKey(side, messageId, emoji) {
  return `${side}:${messageId}:${emoji.id ?? emoji.name}`;
}

function getReactionState(key) {
  let state = reactionState.get(key);
  if (!state) {
    state = { users: new Set(), seeded: false, ready: null };
    reactionState.set(key, state);
  }
  return state;
}

/**
 * @param {{ users: Set<string>, seeded: boolean, ready: Promise<void> | null }} state
 * @param {() => Promise<string[]>} seed
 */
async function seedReactionState(state, seed) {
  if (state.seeded) return;
  if (!state.ready) {
    state.ready = (async () => {
      try {
        for (const id of await seed()) state.users.add(id);
      } catch {}
      state.seeded = true;
      state.ready = null;
    })();
  }
  await state.ready;
}

/**
 * @param {string} key
 * @param {string | undefined} userId
 * @param {"add" | "remove"} action
 * @param {() => Promise<string[]>} seed
 */
async function trackReactionState(key, userId, action, seed) {
  const state = getReactionState(key);
  await seedReactionState(state, seed);
  if (userId) {
    if (action === "add") state.users.add(userId);
    else state.users.delete(userId);
  }
  reactionState.set(key, state);
  return state.users.size > 0;
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
  const stillPresent = await trackReactionState(
    reactionStateKey("discord", reaction.message.id, emoji),
    user.id,
    action,
    async () => {
      const users = await reaction.users.fetch({ limit: 100 });
      return [...users.values()].filter(u => !u.bot).map(u => u.id);
    }
  );
  if (action === "remove" && stillPresent) return;

  let emojiStr;

  if (!emoji.id) {
    // Unicode emoji — use as-is
    emojiStr = emoji.name;
  } else {
    // Custom emoji
    emojiStr = await mirrorDiscordEmojiToFluxer(
      emoji.id,
      emoji.animated ?? false,
      fluxerClient,
      channelMap.fluxerGuildId,
      emoji.name
    );
  }

  if (!emojiStr) return;

  const route = `${FluxerRoutes.channelMessageReaction(channelMap.fluxerChannelId, messageMap.fluxerMessageId, emojiStr)}/@me`;

  await withFluxerRateLimit(
    () => (action === "add" ? fluxerClient.rest.put(route) : fluxerClient.rest.delete(route)),
    `reaction:${channelMap.fluxerChannelId}`
  );
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
  const stillPresent = await trackReactionState(
    reactionStateKey("fluxer", reaction.messageId, emoji),
    user?.id,
    action,
    async () => {
      const message = reaction.message ?? (await reaction.fetchMessage());
      const users = await withFluxerRateLimit(
        () => message.fetchReactionUsers(reaction.emoji, { limit: 100 }),
        `reaction:${message.channelId}`
      );
      return users.filter(u => u.id !== fluxerClient.user?.id).map(u => u.id);
    }
  );
  if (action === "remove" && stillPresent) return;

  let emojiStr;

  if (!emoji.id) {
    emojiStr = emoji.name;
  } else {
    emojiStr = await mirrorFluxerEmojiToDiscord(emoji.id, emoji.animated, discordClient, channelMap.discordGuildId, emoji.name);
  }

  if (!emojiStr) return;

  const route = `${DiscordRoutes.channelMessageReaction(channelMap.discordChannelId, messageMap.discordMessageId, emojiStr)}/@me`;

  if (action === "add") {
    await discordClient.rest.put(route);
  } else {
    await discordClient.rest.delete(route);
  }
}

async function normalizeFluxerEmojiName(fluxerClient, name) {
  if (!/^\w+$/.test(name ?? "")) return name;
  try {
    return await fluxerClient.resolveEmoji(name);
  } catch {
    return name;
  }
}

/**
 * Register reaction relay handlers on both clients.
 * @param {import("discord.js").Client} discordClient discord instance
 * @param {import("@fluxerjs/core").Client} fluxerClient fluxer instance
 */
export function setupReactionHandling(discordClient, fluxerClient) {
  discordClient.on(DiscordEvents.MessageReactionAdd, async (reaction, user) => {
    const infoEmoji = await getInfoReactionEmoji(reaction.message.guildId).catch(() => DEFAULT_INFO_EMOJI);
    if (isInfoReactionEmoji(reaction.emoji.id, reaction.emoji.name, infoEmoji)) {
      try {
        if (await sendBridgeInfo(await reaction.message.fetch(), user, discordClient, fluxerClient)) {
          await reaction.remove();
        }
      } catch {}
      return;
    }

    relayDiscordReaction(reaction, user, "add", fluxerClient).catch(e => {
      if (!isFluxerRateLimitError(e)) log("FLUXER", `Discord→Fluxer reaction relay failed: ${e}`);
    });
  });

  discordClient.on(DiscordEvents.MessageReactionRemove, (reaction, user) => {
    relayDiscordReaction(reaction, user, "remove", fluxerClient).catch(e => {
      if (!isFluxerRateLimitError(e)) log("FLUXER", `Discord→Fluxer reaction remove relay failed: ${e}`);
    });
  });

  fluxerClient.on(FluxerEvents.MessageReactionAdd, async payload => {
    const { reaction, user } = payload;
    const infoEmoji = await getInfoReactionEmoji(reaction.guildId).catch(() => DEFAULT_INFO_EMOJI);
    const emojiName = reaction.emoji.id ? reaction.emoji.name : await normalizeFluxerEmojiName(fluxerClient, reaction.emoji.name);
    if (isInfoReactionEmoji(reaction.emoji.id, emojiName, infoEmoji)) {
      const message = await reaction.fetchMessage();
      try {
        if (await sendBridgeInfo(message, user, discordClient, fluxerClient)) {
          await message.removeReactionEmoji(reaction.emoji.name);
        }
      } catch {}

      return;
    }

    relayFluxerReaction(reaction, user, "add", discordClient, fluxerClient).catch(e =>
      log("DISCORD", `Fluxer→Discord reaction relay failed: ${e}`)
    );
  });

  fluxerClient.on(FluxerEvents.MessageReactionRemove, payload => {
    const { reaction, user } = payload;
    relayFluxerReaction(reaction, user, "remove", discordClient, fluxerClient).catch(e =>
      log("DISCORD", `Fluxer→Discord reaction remove relay failed: ${e}`)
    );
  });
}
