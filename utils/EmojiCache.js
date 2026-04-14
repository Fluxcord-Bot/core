//@ts-check
import ExpiryMap from "expiry-map";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** @type {ExpiryMap<string, Array<{ name: string, id: string }>>} */
const fluxEmojiCache = new ExpiryMap(CACHE_TTL);

/** @type {ExpiryMap<string, Array<{ name: string, id: string }>>} */
const discordEmojiCache = new ExpiryMap(CACHE_TTL);

/** @type {ExpiryMap<string, Map<string, { name: string, id: string }>>} */
const botEmojiCache = new ExpiryMap(CACHE_TTL);

/**
 * @param {string} guildId fluxer Community ID
 * @param {FluxerClient} fluxerClient fluxer instance
 */
export async function getFluxEmojis(guildId, fluxerClient) {
    const cached = fluxEmojiCache.get(guildId);
    if (cached) return cached;

    const guild = await fluxerClient.guilds.fetch(guildId);
    const emojis = await guild?.fetchEmojis();
    const mapped = (emojis ?? []).map((x) => ({ name: x.name, id: x.id }));
    fluxEmojiCache.set(guildId, mapped);
    return mapped;
}

/**
 * @param {string} guildId discord Guild ID
 * @param {DiscordClient} discordClient discord instance
 */
export async function getDiscordEmojis(guildId, discordClient) {
    const cached = discordEmojiCache.get(guildId);
    if (cached) return cached;

    const guild = await discordClient.guilds.fetch(guildId);
    const emojis = await guild.emojis.fetch();
    const mapped = emojis.map((x) => ({ name: x.name ?? "", id: x.id }));
    discordEmojiCache.set(guildId, [...mapped.values()]);
    return [...mapped.values()];
}

/**
 * @param {DiscordClient} discordClient discord instance
 */
export async function getBotEmojis(discordClient) {
    const cached = botEmojiCache.get("app");
    if (cached) return cached;

    const fetched = await discordClient.application?.emojis.fetch();
    /** @type {Map<string, { name: string, id: string }>} */
    const mapped = new Map();
    fetched?.forEach((x) => mapped.set(x.id, { name: x.name ?? "", id: x.id }));
    botEmojiCache.set("app", mapped);
    return mapped;
}

/** @param {string} guildId fluxer Community ID*/
export function clearFluxEmojiCache(guildId) {
    fluxEmojiCache.delete(guildId);
}

/** @param {string} guildId discord Guild ID*/
export function clearDiscEmojiCache(guildId) {
    discordEmojiCache.delete(guildId);
}

export function clearBotEmojiCache() {
    botEmojiCache.delete("app");
}
