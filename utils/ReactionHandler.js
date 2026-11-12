import ExpiryMap from "expiry-map";
import { Events as DiscordEvents, Routes as DiscordRoutes } from "discord.js";
import { Events as FluxerEvents, Routes as FluxerRoutes } from "@fluxerjs/core";
import { Op } from "sequelize";
import { BridgeGroup, MessageLink } from "../db/index.js";
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
import { resolveFluxerClient, instanceIdOfClient } from "./FluxerClients.js";
import { getFluxerInstanceConfig } from "./ConfigHandler.js";
import { getDiscordWebhook } from "./Webhooks.js";

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
 * @param {string} discordEmojiId
 * @param {boolean} animated
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {string} targetFluxerGuildId
 * @param {string} tempGuildId
 * @param {string | null} emojiName
 */
async function mirrorDiscordEmojiToFluxer(discordEmojiId, animated, fluxerClient, targetFluxerGuildId, tempGuildId, emojiName) {
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
  const ensured = await ensureFluxerEmojis(fluxerClient, [token], tempGuildId);
  const emoji = ensured.get(token);
  return emoji?.id ? `${emoji.name}:${emoji.id}` : null;
}

/**
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

function directionAllowed(sourcePlatform, targetPlatform, bridgeType) {
  if (sourcePlatform === targetPlatform) return bridgeType === "both";
  if (sourcePlatform === "fluxer") return bridgeType !== "discord2fluxer";
  return bridgeType !== "fluxer2discord";
}

/**
 * @param {any} sourceRow MessageLink row on the source platform
 * @param {"discord" | "fluxer"} sourcePlatform
 * @returns {Promise<{ link: MessageLink, endpoint: any, bridgeType: string }[]>}
 */
async function relayTargets(sourceRow, sourcePlatform) {
  const siblings = await MessageLink.findAll({ where: { linkGroup: sourceRow.linkGroup }, include: ["endpoint"] });
  const groups = await BridgeGroup.findAll({ where: { id: { [Op.in]: [...new Set(siblings.map(s => s.endpoint?.groupId))] } }, raw: true });
  const typeById = new Map(groups.map(g => [g.id, g.bridgeType]));
  const channelId = sourceRow.endpoint?.channelId;

  /** @type {{ link: MessageLink, endpoint: any, bridgeType: string }[]} */
  const out = [];
  for (const link of siblings) {
    const endpoint = link.endpoint;
    if (!endpoint) continue;
    if (endpoint.platform === sourcePlatform && endpoint.channelId === channelId) continue;
    if (!directionAllowed(sourcePlatform, endpoint.platform, typeById.get(endpoint.groupId))) continue;
    out.push({ link, endpoint, bridgeType: typeById.get(endpoint.groupId) });
  }
  return out;
}

/**
 * @param {import("discord.js").MessageReaction | import("discord.js").PartialMessageReaction} reaction
 * @param {import("discord.js").User | import("discord.js").PartialUser} user
 * @param {"add" | "remove"} action
 * @param {import("discord.js").Client} discordClient
 */
async function relayDiscordReaction(reaction, user, action, discordClient) {
  if (user.bot) return;

  const sourceRows = await MessageLink.findAll({ where: { messageId: reaction.message.id }, include: ["endpoint"] });
  const ownRows = sourceRows.filter(r => r.endpoint?.platform === "discord" && r.endpoint?.channelId === reaction.message.channelId);
  if (ownRows.length === 0) return;

  const emoji = reaction.emoji;

  for (const own of ownRows) {
    const targets = await relayTargets(own, "discord");

    const stateKey = reactionStateKey("discord", reaction.message.id, emoji);
    const stillPresent = await trackReactionState(stateKey, user.id, action, async () => {
      const users = await reaction.users.fetch({ limit: 100 });
      return [...users.values()].filter(u => !u.bot).map(u => u.id);
    });
    if (action === "remove" && stillPresent) continue;

    let emojiStr;
    if (!emoji.id) {
      emojiStr = emoji.name;
    } else {
      const fluxerTarget = targets.find(t => t.endpoint.platform === "fluxer");
      if (!fluxerTarget) continue;
      const fluxerClient = resolveFluxerClient(fluxerTarget.endpoint.instanceId);
      const tempGuildId = getFluxerInstanceConfig(fluxerTarget.endpoint.instanceId)?.FluxerTempEmojiGuildId;
      emojiStr = await mirrorDiscordEmojiToFluxer(
        emoji.id,
        emoji.animated ?? false,
        fluxerClient,
        fluxerTarget.endpoint.guildId,
        tempGuildId,
        emoji.name
      );
    }

    for (const { link, endpoint } of targets.filter(t => t.endpoint.platform === "fluxer")) {
      const fluxerClient = resolveFluxerClient(endpoint.instanceId);
      const route = `${FluxerRoutes.channelMessageReaction(endpoint.channelId, link.messageId, emojiStr)}/@me`;
      try {
        await withFluxerRateLimit(
          () => (action === "add" ? fluxerClient.rest.put(route) : fluxerClient.rest.delete(route)),
          `reaction:${endpoint.channelId}`
        );
      } catch (e) {
        log("FLUXER", `Discord→Fluxer reaction ${action} failed for ${endpoint.channelId}`, e);
      }
    }
  }
}

/**
 * @param {any} reaction
 * @param {any} user
 * @param {"add" | "remove"} action
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient source instance client
 * @param {string} instanceId source instance id
 */
async function relayFluxerReaction(reaction, user, action, discordClient, fluxerClient, instanceId) {
  if (user?.id === fluxerClient.user?.id) return;

  const sourceRows = await MessageLink.findAll({ where: { messageId: reaction.messageId }, include: ["endpoint"] });
  const ownRows = sourceRows.filter(r => r.endpoint?.platform === "fluxer" && r.endpoint?.channelId === reaction.channelId);
  if (ownRows.length === 0) return;

  const emoji = reaction.emoji;

  for (const own of ownRows) {
    const targets = await relayTargets(own, "fluxer");

    const stateKey = reactionStateKey("fluxer", reaction.messageId, emoji);
    const stillPresent = await trackReactionState(stateKey, user?.id, action, async () => {
      const message = reaction.message ?? (await reaction.fetchMessage());
      const users = await withFluxerRateLimit(
        () => message.fetchReactionUsers(reaction.emoji, { limit: 100 }),
        `reaction:${message.channelId}`
      );
      return users.filter(u => u.id !== fluxerClient.user?.id).map(u => u.id);
    });
    if (action === "remove" && stillPresent) continue;

    let emojiStr;
    if (!emoji.id) {
      emojiStr = emoji.name;
    } else {
      emojiStr = await mirrorFluxerEmojiToDiscord(emoji.id, emoji.animated, discordClient, targets[0]?.endpoint.guildId, emoji.name);
    }
    if (!emojiStr) continue;

    for (const { link, endpoint } of targets.filter(t => t.endpoint.platform === "discord")) {
      const route = `${DiscordRoutes.channelMessageReaction(endpoint.channelId, link.messageId, emojiStr)}/@me`;
      try {
        if (action === "add") await discordClient.rest.put(route);
        else await discordClient.rest.delete(route);
      } catch (e) {
        log("DISCORD", `Fluxer→Discord reaction ${action} failed for ${endpoint.channelId}`, e);
      }
    }
  }
}

function normalizeFluxerEmojiName(fluxerClient, name) {
  if (!/^\w+$/.test(name ?? "")) return name;
  try {
    return fluxerClient.resolveEmoji(name);
  } catch {
    return name;
  }
}

/**
 * @param {import("discord.js").Client} discordClient
 */
export function setupReactionHandling(discordClient) {
  discordClient.on(DiscordEvents.MessageReactionAdd, async (reaction, user) => {
    const infoEmoji = await getInfoReactionEmoji(reaction.message.guildId).catch(() => DEFAULT_INFO_EMOJI);
    if (isInfoReactionEmoji(reaction.emoji.id, reaction.emoji.name, infoEmoji)) {
      try {
        if (await sendBridgeInfo(await reaction.message.fetch(), user, discordClient)) {
          await reaction.remove();
        }
      } catch {}
      return;
    }

    relayDiscordReaction(reaction, user, "add", discordClient).catch(e => {
      if (!isFluxerRateLimitError(e)) log("FLUXER", `Discord→Fluxer reaction relay failed: ${e}`);
    });
  });

  discordClient.on(DiscordEvents.MessageReactionRemove, (reaction, user) => {
    relayDiscordReaction(reaction, user, "remove", discordClient).catch(e => {
      if (!isFluxerRateLimitError(e)) log("FLUXER", `Discord→Fluxer reaction remove relay failed: ${e}`);
    });
  });
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export function setupFluxerReactionHandling(discordClient, fluxerClient) {
  const instanceId = instanceIdOfClient(fluxerClient) ?? "default";

  fluxerClient.on(FluxerEvents.MessageReactionAdd, async payload => {
    const { reaction, user } = payload;
    const infoEmoji = await getInfoReactionEmoji(reaction.guildId).catch(() => DEFAULT_INFO_EMOJI);
    const emojiName = reaction.emoji.id ? reaction.emoji.name : normalizeFluxerEmojiName(fluxerClient, reaction.emoji.name);
    if (isInfoReactionEmoji(reaction.emoji.id, emojiName, infoEmoji)) {
      const message = await reaction.fetchMessage();
      try {
        if (await sendBridgeInfo(message, user, discordClient)) {
          await message.removeReactionEmoji(reaction.emoji.name);
        }
      } catch {}
      return;
    }

    relayFluxerReaction(reaction, user, "add", discordClient, fluxerClient, instanceId).catch(e =>
      log("DISCORD", `Fluxer→Discord reaction relay failed: ${e}`)
    );
  });

  fluxerClient.on(FluxerEvents.MessageReactionRemove, payload => {
    const { reaction, user } = payload;
    relayFluxerReaction(reaction, user, "remove", discordClient, fluxerClient, instanceId).catch(e =>
      log("DISCORD", `Fluxer→Discord reaction remove relay failed: ${e}`)
    );
  });
}

