import { log } from "./Logger.js";
import Config from "../utils/ConfigHandler.js";
import { ChannelMap, MessageMap } from "../db/index.js";
import { Op } from "sequelize";
import { getFluxEmojis, getDiscordEmojis, getBotEmojis, clearFluxEmojiCache, clearBotEmojiCache } from "./EmojiCache.js";
import { getFluxerMediaBaseUrl, getFluxerWebappUrl } from "./GetFluxerUrls.js";

const EMOJI_DELETE_BATCH = 10;
const EMOJI_DELETE_MARGIN = 2;
const EMOJI_BULK_LIMIT = 50;

let fluxerEmojiCooldownUntil = 0;
let discordEmojiCooldownUntil = 0;

const fluxerEmojiInflight = new Map();
const discordEmojiInflight = new Map();

export function isFluxerEmojiRateLimited() {
  return Date.now() < fluxerEmojiCooldownUntil;
}

export function isDiscordEmojiRateLimited() {
  return Date.now() < discordEmojiCooldownUntil;
}

function isRateLimitError(e) {
  return e?.code === "RATE_LIMITED" || e?.status === 429;
}

function isMaxEmojisError(e) {
  return e?.code === "MAX_EMOJIS" || e?.code === 30008;
}

function startFluxerCooldown(e) {
  const retryAfter = Number(e?.retryAfter) > 0 ? Number(e.retryAfter) : 30;
  fluxerEmojiCooldownUntil = Date.now() + retryAfter * 1000 + 1000;
  log("FLUXER", `Cannot convert Discord emoji to Fluxer (guild ${Config.FluxerTempEmojiGuildId}), using emoji links until the rate limit resets`, e);
}

function startDiscordCooldown(e) {
  const retryAfter = Number(e?.retryAfter) > 0 ? Number(e.retryAfter) : 30;
  discordEmojiCooldownUntil = Date.now() + retryAfter * 1000 + 1000;
  log("DISCORD", "Cannot convert Fluxer emoji to Discord, using emoji links until the rate limit resets", e);
}

function isValidEmojiToken(token) {
  return /^\d{17,19}$/.test(token.startsWith("a") ? token.slice(1) : token);
}

function discordEmojiLink(token, name) {
  const animated = token.startsWith("a");
  const rawId = animated ? token.slice(1) : token;
  const url = `https://cdn.discordapp.com/emojis/${rawId}${animated ? ".gif" : ".webp"}?size=48`;
  return name ? `[${name}](${url})` : url;
}

async function fluxerEmojiLink(token, name) {
  const animated = token.startsWith("a");
  const rawId = animated ? token.slice(1) : token;
  const mediaBase = await getFluxerMediaBaseUrl();
  if (!mediaBase) return `:${token}:`;
  const url = `${mediaBase}/emojis/${rawId}.webp${animated ? "?animated=true" : ""}&size=48`;
  return name ? `[${name}](${url})` : url;
}

function applyEmojiReplacements(result, replacements) {
  for (const [token, replacement] of replacements) {
    result = result.replaceAll(`:${token}:`, replacement);
  }
  return result;
}

function settleEmojiResults(out, tokens) {
  for (const token of tokens) {
    if (!out.has(token)) out.set(token, null);
  }
  return out;
}

/**
 * @param {string | null} content Message content
 * @param {FluxerClient} fluxerClient Fluxer client instance
 * @param {string | null} targetFluxerGuildId Target fluxer guild (emoji check)
 */
export async function parseDiscordEmojiToFluxer(content, fluxerClient, targetFluxerGuildId) {
  if (!content) return content;

  const emojiIdNameMap = new Map();
  let result = content.replace(/<(a?):([\w\-\_]+):(\d+)>/g, (_, animated, name, id) => {
    emojiIdNameMap.set(`${animated}${id}`, name);
    return `:${animated}${id}:`;
  });

  const tokens = [...new Set([...result.matchAll(/:(a?\d+):/g)].map(m => m[1]))].filter(isValidEmojiToken);
  if (tokens.length === 0) return result;

  const replacements = new Map();

  if (isFluxerEmojiRateLimited()) {
    for (const token of tokens) {
      replacements.set(token, discordEmojiLink(token, emojiIdNameMap.get(token)));
    }
    return applyEmojiReplacements(result, replacements);
  }

  /** @type {Array<{ name: string, id: string }> | null} */
  let targetGuildEmojis = null;
  if (targetFluxerGuildId) {
    try {
      targetGuildEmojis = await getFluxEmojis(targetFluxerGuildId, fluxerClient);
    } catch {
      targetGuildEmojis = null;
    }
  }

  const staged = [];
  for (const token of tokens) {
    const sourceName = emojiIdNameMap.get(token);
    const byName = sourceName && targetGuildEmojis?.find(x => x.name === sourceName);
    if (byName) {
      replacements.set(token, `<:${byName.name}:${byName.id}>`);
      continue;
    }
    staged.push(token);
  }

  if (staged.length > 0) {
    const ensured = await ensureFluxerEmojis(fluxerClient, staged);
    for (const token of staged) {
      const emoji = ensured.get(token);
      if (emoji?.id) {
        replacements.set(token, `<${token.startsWith("a") ? "a:" : ":"}${emoji.name}:${emoji.id}>`);
      } else {
        replacements.set(token, discordEmojiLink(token, emojiIdNameMap.get(token)));
      }
    }
  }

  return applyEmojiReplacements(result, replacements);
}

/**
 * @param {string | null} content
 * @param {DiscordClient} discordClient
 * @param {string | null} targetDiscordGuildId
 */
export async function parseFluxerEmojiToDiscord(content, discordClient, targetDiscordGuildId) {
  if (!content) return content;

  const emojiIdNameMap = new Map();
  let result = content.replace(/<(a?):([\w\-\_]+):(\d+)>/g, (_, animated, name, id) => {
    emojiIdNameMap.set(`${animated}${id}`, name);
    return `:${animated}${id}:`;
  });
  result = result.replace(/:e(a?\d+):/g, ":$1:");

  const tokens = [...new Set([...result.matchAll(/:(a?\d+):/g)].map(m => m[1]))].filter(isValidEmojiToken);
  if (tokens.length === 0) return result;

  const replacements = new Map();

  if (isDiscordEmojiRateLimited()) {
    for (const token of tokens) {
      replacements.set(token, await fluxerEmojiLink(token, emojiIdNameMap.get(token)));
    }
    return applyEmojiReplacements(result, replacements);
  }

  /** @type {Array<{ name: string, id: string }> | null} */
  let targetGuildEmojis = null;
  if (targetDiscordGuildId) {
    try {
      targetGuildEmojis = await getDiscordEmojis(targetDiscordGuildId, discordClient);
    } catch {
      targetGuildEmojis = null;
    }
  }

  const staged = [];
  for (const token of tokens) {
    const sourceName = emojiIdNameMap.get(token);
    const byName = sourceName && targetGuildEmojis?.find(x => x.name === sourceName);
    if (byName) {
      replacements.set(token, `<${token.startsWith("a") ? "a" : ""}:${sourceName}:${byName.id}>`);
      continue;
    }
    staged.push(token);
  }

  if (staged.length > 0) {
    const ensured = await ensureDiscordEmojis(discordClient, staged);
    for (const token of staged) {
      const emoji = ensured.get(token);
      if (emoji?.id) {
        replacements.set(token, `<${token.startsWith("a") ? "a" : ""}:${emoji.name}:${emoji.id}>`);
      } else {
        replacements.set(token, await fluxerEmojiLink(token, emojiIdNameMap.get(token)));
      }
    }
  }

  return applyEmojiReplacements(result, replacements);
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
 * @returns {string}
 */
export function sanitizeLinks(str) {
  return str.replace(/https?:\/\/[^\s]+/g, url => `*${new URL(url).hostname}*`);
}

/**
 * @param {string} str
 * @returns {Promise<string>}
 */
export async function traverseMessageLinks(str) {
  let result = str;

  const webAppUrl = await getFluxerWebappUrl();
  const webApp = new URL(webAppUrl);
  const regex = new RegExp(
    `https://(discord\\.com|(?:web.)?(?:canary.)?fluxer.app|${webApp.hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})/channels/(\\d+)/(\\d+)(?:/(\\d+))?`,
    "g"
  );

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
            if (!m[1].includes("discord.com")) {
              result = result.replaceAll(
                m[0],
                `https://discord.com/channels/${message.channelMap.discordGuildId}/${message.channelMap.discordChannelId}/${message.discordMessageId}`
              );
            } else {
              result = result.replaceAll(
                m[0],
                `${webAppUrl}/channels/${message.channelMap.fluxerGuildId}/${message.channelMap.fluxerChannelId}/${message.fluxerMessageId}`
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
                `https://discord.com/channels/${channel.discordGuildId}/${channel.discordChannelId}`
              );
            } else {
              result = result.replaceAll(m[0], `${webAppUrl}/channels/${channel.fluxerGuildId}/${channel.fluxerChannelId}`);
            }
          }
        }
      }
    } catch {}
  }

  return result;
}

export async function ensureFluxerEmojis(fluxerClient, tokens) {
  const resolved = new Map();

  if (isFluxerEmojiRateLimited()) {
    return settleEmojiResults(resolved, tokens);
  }

  let existing;
  try {
    existing = await getFluxEmojis(Config.FluxerTempEmojiGuildId, fluxerClient);
  } catch (e) {
    if (isRateLimitError(e)) startFluxerCooldown(e);
    return settleEmojiResults(resolved, tokens);
  }

  const missing = [];
  for (const token of tokens) {
    const hit = existing.find(x => x.name === `e${token}`);
    if (hit) resolved.set(token, { name: hit.name, id: hit.id });
    else missing.push(token);
  }
  if (missing.length === 0) return resolved;

  const pending = new Map();
  const toCreate = [];
  for (const token of missing) {
    const inFlight = fluxerEmojiInflight.get(token);
    if (inFlight) pending.set(token, inFlight);
    else toCreate.push(token);
  }

  if (toCreate.length > 0) {
    const batch = createFluxerEmojis(fluxerClient, toCreate);
    for (const token of toCreate) {
      const entry = batch.then(results => results.get(token) ?? null);
      fluxerEmojiInflight.set(token, entry);
      pending.set(token, entry);
    }
    batch.finally(() => {
      for (const token of toCreate) fluxerEmojiInflight.delete(token);
    });
  }

  for (const [token, entry] of pending) {
    resolved.set(token, await entry);
  }
  return resolved;
}

export async function ensureDiscordEmojis(discordClient, tokens) {
  const resolved = new Map();

  if (isDiscordEmojiRateLimited()) {
    return settleEmojiResults(resolved, tokens);
  }

  let existing;
  try {
    existing = await getBotEmojis(discordClient);
  } catch (e) {
    if (isRateLimitError(e)) startDiscordCooldown(e);
    return settleEmojiResults(resolved, tokens);
  }

  const missing = [];
  for (const token of tokens) {
    const hit = [...existing.values()].find(x => x.name === `e${token}`);
    if (hit) resolved.set(token, { name: hit.name, id: hit.id });
    else missing.push(token);
  }
  if (missing.length === 0) return resolved;

  const pending = new Map();
  const toCreate = [];
  for (const token of missing) {
    const inFlight = discordEmojiInflight.get(token);
    if (inFlight) pending.set(token, inFlight);
    else toCreate.push(token);
  }

  if (toCreate.length > 0) {
    const batch = createDiscordEmojis(discordClient, toCreate);
    for (const token of toCreate) {
      const entry = batch.then(results => results.get(token) ?? null);
      discordEmojiInflight.set(token, entry);
      pending.set(token, entry);
    }
    batch.finally(() => {
      for (const token of toCreate) discordEmojiInflight.delete(token);
    });
  }

  for (const [token, entry] of pending) {
    resolved.set(token, await entry);
  }
  return resolved;
}

async function createFluxerEmojis(fluxerClient, tokens) {
  const out = new Map();
  try {
    const payloads = new Map();
    for (const token of tokens) {
      const animated = token.startsWith("a");
      const rawId = animated ? token.slice(1) : token;
      try {
        const res = await fetch(`https://cdn.discordapp.com/emojis/${rawId}${animated ? ".gif" : ".webp"}`);
        if (!res.ok) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        payloads.set(token, {
          name: `e${token}`,
          image: btoa(buf.reduce((data, byte) => data + String.fromCharCode(byte), "")),
        });
      } catch {
        continue;
      }
    }

    const pass1 = await bulkCreateFluxerEmojis(fluxerClient, [...payloads.entries()], out);
    if (pass1.rateLimited) return settleEmojiResults(out, tokens);

    if (pass1.maxEmojis.length > 0) {
      try {
        await deleteOldestEmojisFluxer(fluxerClient, Math.min(pass1.maxEmojis.length + EMOJI_DELETE_MARGIN, EMOJI_DELETE_BATCH));
      } catch (e) {
        if (isRateLimitError(e)) startFluxerCooldown(e);
        return settleEmojiResults(out, tokens);
      }
      await bulkCreateFluxerEmojis(fluxerClient, pass1.maxEmojis.map(t => [t, payloads.get(t)]).filter(([, p]) => p), out);
    }
  } catch (e) {
    if (isRateLimitError(e)) startFluxerCooldown(e);
    else log("FLUXER", "Cannot convert Discord emoji to Fluxer: " + e);
  }
  return settleEmojiResults(out, tokens);
}

async function bulkCreateFluxerEmojis(fluxerClient, entries, out) {
  const maxEmojis = [];
  for (let i = 0; i < entries.length; i += EMOJI_BULK_LIMIT) {
    const chunk = entries.slice(i, i + EMOJI_BULK_LIMIT);
    try {
      const guild = await fluxerClient.guilds.fetch(Config.FluxerTempEmojiGuildId);
      const res = await guild?.createEmojisBulk(chunk.map(([, payload]) => payload));
      let createdAny = false;
      for (const created of res?.success ?? []) {
        const token = chunk.find(([t]) => `e${t}` === created.name)[0];
        if (created?.id) {
          out.set(token, { name: created.name, id: created.id });
          createdAny = true;
        }
      }
      for (const failed of res?.failed ?? []) {
        if (failed?.error === "MAX_EMOJIS") {
          maxEmojis.push(chunk.find(([t]) => `e${t}` === failed.name)[0]);
        }
      }
      if (createdAny) clearFluxEmojiCache(Config.FluxerTempEmojiGuildId);
    } catch (e) {
      if (isRateLimitError(e)) {
        startFluxerCooldown(e);
        return { rateLimited: true, maxEmojis };
      }
      if (isMaxEmojisError(e)) {
        maxEmojis.push(...chunk.map(([t]) => t));
      } else {
        log("FLUXER", "Cannot convert Discord emoji to Fluxer: " + e);
      }
    }
  }
  return { rateLimited: false, maxEmojis };
}

async function createDiscordEmojis(discordClient, tokens) {
  const out = new Map();
  try {
    const failedMax = [];
    for (const token of tokens) {
      try {
        const created = await createDiscordEmoji(discordClient, token);
        if (created) out.set(token, created);
      } catch (e) {
        if (isRateLimitError(e)) {
          startDiscordCooldown(e);
          return settleEmojiResults(out, tokens);
        }
        if (isMaxEmojisError(e)) failedMax.push(token);
        else log("DISCORD", "Cannot convert Fluxer emoji to Discord: " + e);
      }
    }

    if (failedMax.length > 0) {
      try {
        await deleteOldestEmojisDiscord(discordClient, Math.min(failedMax.length + EMOJI_DELETE_MARGIN, EMOJI_DELETE_BATCH));
      } catch (e) {
        if (isRateLimitError(e)) startDiscordCooldown(e);
        return settleEmojiResults(out, tokens);
      }
      for (const token of failedMax) {
        try {
          const created = await createDiscordEmoji(discordClient, token);
          if (created) out.set(token, created);
        } catch (e) {
          if (isRateLimitError(e)) {
            startDiscordCooldown(e);
            break;
          }
          if (!isMaxEmojisError(e)) log("DISCORD", "Cannot convert Fluxer emoji to Discord: " + e);
        }
      }
    }
  } catch (e) {
    if (isRateLimitError(e)) startDiscordCooldown(e);
    else log("DISCORD", "Cannot convert Fluxer emoji to Discord: " + e);
  }
  return settleEmojiResults(out, tokens);
}

async function createDiscordEmoji(discordClient, token) {
  const animated = token.startsWith("a");
  const rawId = animated ? token.slice(1) : token;
  const mediaBase = await getFluxerMediaBaseUrl();
  if (!mediaBase) return null;

  const res = await fetch(
    `${mediaBase}/emojis/${rawId}.webp?animated=${animated ? "true" : "false"}&size=240&quality=lossless`
  );
  if (!res.ok) return null;

  const created = await discordClient.application?.emojis.create({
    attachment: Buffer.from(await res.arrayBuffer()),
    name: `e${token}`,
  });
  if (created?.id) {
    clearBotEmojiCache();
    return { name: created.name ?? `e${token}`, id: created.id };
  }
  return null;
}

/**
 * @param {FluxerClient} fluxerClient
 * @param {number} count
 */
async function deleteOldestEmojisFluxer(fluxerClient, count) {
  const guild = await fluxerClient.guilds.fetch(Config.FluxerTempEmojiGuildId);
  if (!guild) return;
  try {
    const emojis = (await guild.fetchEmojis())
      .filter(x => !x.name.startsWith("reply") && x.name !== "loading")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, count);
    for (const emoji of emojis) {
      await emoji.delete();
    }
  } catch (e) {
    log("FLUXER", `Cannot delete oldest emojis on Fluxer (guild ${Config.FluxerTempEmojiGuildId}): ` + e);
    throw e;
  }
  clearFluxEmojiCache(Config.FluxerTempEmojiGuildId);
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {number} count
 */
async function deleteOldestEmojisDiscord(discordClient, count) {
  const app = await discordClient.application?.fetch();
  if (!app) return;
  try {
    const emojis = [...(await app.emojis.fetch()).values()]
      .filter(x => !x.name.startsWith("reply") && x.name !== "loading")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, count);
    for (const emoji of emojis) {
      await emoji?.delete();
    }
  } catch (e) {
    log("DISCORD", "Cannot delete oldest emojis on Discord: " + e);
    throw e;
  }
  clearBotEmojiCache();
}
