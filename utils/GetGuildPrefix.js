import { GuildMap } from "../db/index.js";
import Config from "./ConfigHandler.js";

const CACHE_TTL_MS = 30_000;
/** @type {Map<string, { prefix: string, at: number }>} */
const prefixCache = new Map();

function cacheKey(guildId, guildType) {
  return `${guildType ?? "*"}:${guildId}`;
}

/**
 * Drops cached prefixes for a guild (both the platform-scoped and the
 * unscoped fallback entries). Call after mutating a guild's prefix.
 *
 * @param {string} guildId
 */
export function invalidateGuildPrefix(guildId) {
  for (const key of [...prefixCache.keys()]) {
    if (key.endsWith(`:${guildId}`)) prefixCache.delete(key);
  }
}

/**
 * Resolves the effective command prefix for a guild.
 * Returns the guild's custom prefix when one is set,
 * otherwise falls back to the global prefix from the config.
 *
 * When `guildType` is provided the lookup is scoped to that platform, which
 * avoids matching a Discord guild and a Fluxer community that share an ID.
 *
 * @param {string} guildId
 * @param {"discord" | "fluxer"} [guildType]
 * @returns {Promise<string>}
 */
export async function getGuildPrefix(guildId, guildType) {
  if (!guildId) return Config.BotPrefix;

  const key = cacheKey(guildId, guildType);
  const cached = prefixCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.prefix;

  const guildMap = await GuildMap.findOne({
    where: guildType ? { guildId, guildType } : { guildId },
  });

  const prefix = guildMap?.botPrefix || Config.BotPrefix;
  prefixCache.set(key, { prefix, at: Date.now() });
  return prefix;
}
