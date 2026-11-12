import { log } from "./Logger.js";
import Config from "../utils/ConfigHandler.js";
import { MessageLink } from "../db/index.js";
import { Op } from "sequelize";
import { getFluxEmojis, getDiscordEmojis, getBotEmojis, clearFluxEmojiCache, clearBotEmojiCache } from "./EmojiCache.js";
import { getFluxerMediaBaseUrl, getFluxerWebappUrl } from "./GetFluxerUrls.js";
import { fluxerConfigOfClient, tempEmojiGuildFor } from "./PerInstance.js";

const EMOJI_DELETE_BATCH = 10;
const EMOJI_DELETE_MARGIN = 2;
const EMOJI_BULK_LIMIT = 50;

let fluxerEmojiCooldownUntil = 0;
let discordEmojiCooldownUntil = 0;

const fluxerEmojiInflight = new Map();
const discordEmojiInflight = new Map();

const emojiGuildLocks = new Map();

function withEmojiGuildLock(key, fn) {
  const prevTail = emojiGuildLocks.get(key) ?? Promise.resolve();
  const run = prevTail.then(fn, fn);
  emojiGuildLocks.set(
    key,
    run.catch(() => {})
  );
  return run;
}

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

function isMaxEmojisFailure(error) {
  return error === "MAX_EMOJIS" || /maximum number of emojis/i.test(error ?? "");
}

function startFluxerCooldown(e, tempGuildId) {
  const retryAfter = Number(e?.retryAfter) > 0 ? Number(e.retryAfter) : 30;
  fluxerEmojiCooldownUntil = Date.now() + retryAfter * 1000 + 1000;
  log(
    "FLUXER",
    `Cannot convert Discord emoji to Fluxer (guild ${tempGuildId}), using emoji links until the rate limit resets`,
    e
  );
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

async function fluxerEmojiLink(token, name, instanceId = "default") {
  const animated = token.startsWith("a");
  const rawId = animated ? token.slice(1) : token;
  const mediaBase = await getFluxerMediaBaseUrl(instanceId);
  if (!mediaBase) return `:${token}:`;
  const url = `${mediaBase}/emojis/${rawId}.webp${animated ? "?animated=true&" : "?"}size=48`;
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

export async function parseFluxerEmojiToFluxer(content, targetFluxerClient, sourceInstanceId = "default", tempGuildId) {
  if (!content) return content;

  const emojiIdNameMap = new Map();
  let result = content.replace(/<(a?):([\w\-\_]+):(\d+)>/g, (_, animated, name, id) => {
    emojiIdNameMap.set(`${animated}${id}`, name);
    return `:${animated}${id}:`;
  });
  result = result.replace(/:e(a?\d+):/g, ":$1:");

  const tokens = [...new Set([...result.matchAll(/:(a?\d+):/g)].map(m => m[1]))].filter(isValidEmojiToken);
  if (tokens.length === 0) return result;

  const tempGuildIdForTarget =
    tempGuildId ?? fluxerConfigOfClient(targetFluxerClient)?.FluxerTempEmojiGuildId ?? Config.FluxerTempEmojiGuildId;
  const sourceMediaBase = await getFluxerMediaBaseUrl(sourceInstanceId).catch(() => undefined);

  const replacements = new Map();
  if (isFluxerEmojiRateLimited()) {
    for (const token of tokens) {
      replacements.set(token, await fluxerEmojiLink(token, emojiIdNameMap.get(token), sourceInstanceId));
    }
    return applyEmojiReplacements(result, replacements);
  }

  const staged = [];
  const targetEmojis = await getFluxEmojis(tempGuildIdForTarget, targetFluxerClient).catch(() => null);
  for (const token of tokens) {
    const hit = targetEmojis?.find(x => x.name === `e${token}`);
    if (hit) {
      replacements.set(token, `<:${hit.name}:${hit.id}>`);
      continue;
    }
    staged.push(token);
  }

  if (staged.length > 0) {
    const ensured = await Promise.race([
      ensureFluxerEmojis(targetFluxerClient, staged, tempGuildIdForTarget, sourceMediaBase),
      new Promise(resolve => setTimeout(() => resolve(null), 10_000)),
    ]);
    for (const token of staged) {
      const emoji = ensured?.get(token);
      if (emoji?.id) {
        replacements.set(token, `<:${emoji.name}:${emoji.id}>`);
      } else {
        replacements.set(token, await fluxerEmojiLink(token, emojiIdNameMap.get(token), sourceInstanceId));
      }
    }
  }

  return applyEmojiReplacements(result, replacements);
}

export async function parseDiscordEmojiToFluxer(
  content,
  fluxerClient,
  targetFluxerGuildId,
  tempGuildId = fluxerConfigOfClient(fluxerClient)?.FluxerTempEmojiGuildId ?? Config.FluxerTempEmojiGuildId
) {
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
    const ensured = await Promise.race([
      ensureFluxerEmojis(fluxerClient, staged, tempGuildId),
      new Promise(resolve => setTimeout(() => resolve(null), 10_000)),
    ]);
    for (const token of staged) {
      const emoji = ensured?.get(token);
      if (emoji?.id) {
        replacements.set(token, `<${token.startsWith("a") ? "a:" : ":"}${emoji.name}:${emoji.id}>`);
      } else {
        replacements.set(token, discordEmojiLink(token, emojiIdNameMap.get(token)));
      }
    }
  }

  return applyEmojiReplacements(result, replacements);
}

export async function parseFluxerEmojiToDiscord(content, discordClient, targetDiscordGuildId, sourceInstanceId = "default") {
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
      replacements.set(token, await fluxerEmojiLink(token, emojiIdNameMap.get(token), sourceInstanceId));
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
    const ensured = await Promise.race([
      ensureDiscordEmojis(discordClient, staged),
      new Promise(resolve => setTimeout(() => resolve(null), 10_000)),
    ]);
    for (const token of staged) {
      const emoji = ensured?.get(token);
      if (emoji?.id) {
        replacements.set(token, `<${token.startsWith("a") ? "a" : ""}:${emoji.name}:${emoji.id}>`);
      } else {
        replacements.set(token, await fluxerEmojiLink(token, emojiIdNameMap.get(token), sourceInstanceId));
      }
    }
  }

  return applyEmojiReplacements(result, replacements);
}

export function removeLinkEmbeds(str) {
  const regex =
    /(https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(\([-a-zA-Z0-9@:%_+.~#?&/=]*\)|[-a-zA-Z0-9@:%_+.~#?&/=])*)/g;
  return str.replace(regex, "<$1>");
}

export function sanitizeLinks(str) {
  return str.replace(/https?:\/\/[^\s]+/g, url => {
    const [, trimmed, suffix] = url.match(/^(.*?)([…)\]>.,;:!?'"]*)$/);
    try {
      return `*${new URL(trimmed).hostname}*${suffix}`;
    } catch {
      return "*link*";
    }
  });
}

/**
 * @param {string} str
 * @returns {string}
 */
export function flattenMarkdownLinks(str) {
  return str
    .replace(/\[([^\]]*)\]\(\s*<?([^)\s]*?)>?\s*\)/g, (_, label, target) => (label ? `${label} (${target})` : target))
    .replace(/[[\]]/g, "");
}

export async function traverseMessageLinks(str) {
  if (!str) return str;
  if (!str) return str;

  const webAppUrl = await getFluxerWebappUrl();
  const webApp = new URL(webAppUrl);
  const regex = new RegExp(
    `https://(discord\\.com|(?:web.)?(?:canary.)?fluxer.app|${webApp.hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})/channels/(\\d+)/(\\d+)(?:/(\\d+))?`,
    "g"
  );

  const matches = new Map();
  for (const m of str.matchAll(regex)) {
    if (m[1] && m[2] && m[3] && !matches.has(m[0])) matches.set(m[0], m);
  }
  if (matches.size === 0) return str;

  /** @type {Map<string, string>} */
  const rewrites = new Map();

  for (const [url, m] of matches) {
    try {
      const id = m[4] ?? m[3];
      const row = await MessageLink.findOne({ where: { messageId: id }, include: ["endpoint"] });
      if (!row) continue;
      const siblings = await MessageLink.findAll({ where: { linkGroup: row.linkGroup }, include: ["endpoint"] });
      const isSourceDiscord = m[1].includes("discord.com");
      const target = siblings.find(x =>
        isSourceDiscord ? x.endpoint?.platform === "fluxer" : x.endpoint?.platform === "discord"
      );
      if (!target?.endpoint) continue;
      if (target.endpoint.platform === "fluxer") {
        const webapp = await getFluxerWebappUrl(target.endpoint.instanceId ?? "default");
        rewrites.set(
          url,
          m[4]
            ? `${webapp}/channels/${target.endpoint.guildId}/${target.endpoint.channelId}/${target.messageId}`
            : `${webapp}/channels/${target.endpoint.guildId}/${target.endpoint.channelId}`
        );
      } else {
        rewrites.set(
          url,
          m[4]
            ? `https://discord.com/channels/${target.endpoint.guildId}/${target.endpoint.channelId}/${target.messageId}`
            : `https://discord.com/channels/${target.endpoint.guildId}/${target.endpoint.channelId}`
        );
      }
    } catch {}
  }

  if (rewrites.size === 0) return str;

  return str.replace(regex, url => rewrites.get(url) ?? url);
  if (rewrites.size === 0) return str;

  return str.replace(regex, url => rewrites.get(url) ?? url);
}

export async function ensureFluxerEmojis(
  fluxerClient,
  tokens,
  tempGuildId = fluxerConfigOfClient(fluxerClient)?.FluxerTempEmojiGuildId ?? Config.FluxerTempEmojiGuildId,
  sourceMediaBase = null
) {
  const resolved = new Map();

  if (isFluxerEmojiRateLimited()) {
    return settleEmojiResults(resolved, tokens);
  }

  let existing;
  try {
    existing = await getFluxEmojis(tempGuildId, fluxerClient);
  } catch (e) {
    if (isRateLimitError(e)) startFluxerCooldown(e, tempGuildId);
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
    const batch = withEmojiGuildLock(`fluxer:${tempGuildId}`, () =>
      createFluxerEmojis(fluxerClient, toCreate, tempGuildId, sourceMediaBase)
    );
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
    const batch = withEmojiGuildLock("discord-app-emojis", () => createDiscordEmojis(discordClient, toCreate));
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

async function createFluxerEmojis(
  fluxerClient,
  tokens,
  tempGuildId = fluxerConfigOfClient(fluxerClient)?.FluxerTempEmojiGuildId ?? Config.FluxerTempEmojiGuildId,
  sourceMediaBase = null
) {
  const out = new Map();
  if (isFluxerEmojiRateLimited()) return settleEmojiResults(out, tokens);
  try {
    const payloads = new Map();
    for (const token of tokens) {
      const animated = token.startsWith("a");
      const rawId = animated ? token.slice(1) : token;
      try {
        const imageUrl = sourceMediaBase
          ? `${sourceMediaBase.replace(/\/$/, "")}/emojis/${rawId}.webp${animated ? "?animated=true" : ""}`
          : `https://cdn.discordapp.com/emojis/${rawId}${animated ? ".gif" : ".webp"}`;
        const res = await fetch(imageUrl);
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

    if (payloads.size > 0) log("FLUXER", `Uploading ${payloads.size} new emoji(s) to Fluxer temp guild`);

    const pass1 = await bulkCreateFluxerEmojis(fluxerClient, [...payloads.entries()], out, tempGuildId);
    if (pass1.rateLimited) return settleEmojiResults(out, tokens);

    if (pass1.maxEmojis.length > 0) {
      const deleteCount = Math.min(pass1.maxEmojis.length + EMOJI_DELETE_MARGIN, EMOJI_DELETE_BATCH);
      log("FLUXER", `Fluxer temp guild is full, deleting ${deleteCount} oldest emoji(s) and retrying`);
      try {
        await deleteOldestEmojisFluxer(fluxerClient, deleteCount, tempGuildId);
      } catch (e) {
        if (isRateLimitError(e)) startFluxerCooldown(e, tempGuildId);
        return settleEmojiResults(out, tokens);
      }
      await bulkCreateFluxerEmojis(
        fluxerClient,
        pass1.maxEmojis.map(t => [t, payloads.get(t)]).filter(([, p]) => p),
        out,
        tempGuildId
      );
    }
  } catch (e) {
    if (isRateLimitError(e)) startFluxerCooldown(e, tempGuildId);
    else log("FLUXER", "Cannot convert Discord emoji to Fluxer: " + e);
  }
  return settleEmojiResults(out, tokens);
}

async function bulkCreateFluxerEmojis(fluxerClient, entries, out, tempGuildId) {
  const maxEmojis = [];
  for (let i = 0; i < entries.length; i += EMOJI_BULK_LIMIT) {
    const chunk = entries.slice(i, i + EMOJI_BULK_LIMIT);
    try {
      const guild = await fluxerClient.guilds.fetch(tempGuildId);
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
        if (isMaxEmojisFailure(failed?.error)) {
          maxEmojis.push(chunk.find(([t]) => `e${t}` === failed.name)[0]);
        }
      }
      if (createdAny) clearFluxEmojiCache(tempGuildId);
    } catch (e) {
      if (isRateLimitError(e)) {
        startFluxerCooldown(e, tempGuildId);
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
  if (isDiscordEmojiRateLimited()) return settleEmojiResults(out, tokens);
  try {
    log("DISCORD", `Uploading ${tokens.length} new emoji(s) to Discord app emojis`);
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
      const deleteCount = Math.min(failedMax.length + EMOJI_DELETE_MARGIN, EMOJI_DELETE_BATCH);
      log("DISCORD", `Discord app emoji store is full, deleting ${deleteCount} oldest emoji(s) and retrying`);
      try {
        await deleteOldestEmojisDiscord(discordClient, deleteCount);
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

  const res = await fetch(`${mediaBase}/emojis/${rawId}.webp?animated=${animated ? "true" : "false"}&size=240&quality=lossless`);
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

async function deleteOldestEmojisFluxer(
  fluxerClient,
  count,
  tempGuildId = fluxerConfigOfClient(fluxerClient)?.FluxerTempEmojiGuildId ?? Config.FluxerTempEmojiGuildId
) {
  const guild = await fluxerClient.guilds.fetch(tempGuildId);
  if (!guild) return;
  try {
    const emojis = (await guild.fetchEmojis())
      .filter(x => !x.name.startsWith("reply") && x.name !== "loading")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, count);
    for (const emoji of emojis) {
      try {
        await emoji.delete();
      } catch (e) {
        if (e?.code !== "UNKNOWN_EMOJI") throw e;
      }
    }
  } catch (e) {
    log("FLUXER", `Cannot delete oldest emojis on Fluxer (guild ${tempGuildId}): ` + e);
    throw e;
  }
  clearFluxEmojiCache(tempGuildId);
}

async function deleteOldestEmojisDiscord(discordClient, count) {
  const app = await discordClient.application?.fetch();
  if (!app) return;
  try {
    const emojis = [...(await app.emojis.fetch()).values()]
      .filter(x => !x.name.startsWith("reply") && x.name !== "loading")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, count);
    for (const emoji of emojis) {
      try {
        await emoji?.delete();
      } catch (e) {
        if (e?.code !== 10008) throw e;
      }
    }
  } catch (e) {
    log("DISCORD", "Cannot delete oldest emojis on Discord: " + e);
    throw e;
  }
  clearBotEmojiCache();
}
