import { Op } from "sequelize";
import { BridgeEndpoint } from "../db/index.js";
import { isFluxerRateLimited, withFluxerRateLimit } from "./FluxerRateLimit.js";

const discordWebhookCache = new Map();

/**
 * @param {import("discord.js").Client} discordClient
 * @param {BridgeEndpoint} endpoint discord-side endpoint with webhookId/webhookToken
 */
export function getDiscordWebhook(discordClient, endpoint) {
  const key = endpoint.webhookId;
  let pending = discordWebhookCache.get(key);
  if (!pending) {
    pending = discordClient.fetchWebhook(endpoint.webhookId, endpoint.webhookToken);
    pending.catch(() => discordWebhookCache.delete(key));
    discordWebhookCache.set(key, pending);
  }
  return pending;
}

export function invalidateDiscordWebhookCache(webhookId) {
  if (!webhookId) return;
  discordWebhookCache.delete(webhookId);
}

const webhookListCache = new Map();
const webhookListInflight = new Map();
const webhookListGeneration = new Map();
const WEBHOOK_CACHE_TTL_MS = 5 * 60_000;

/**
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {string} channelId
 */
function fetchFluxerWebhookIds(fluxerClient, channelId) {
  const existing = webhookListInflight.get(channelId);
  if (existing) return existing;

  const generation = webhookListGeneration.get(channelId) ?? 0;
  const isCurrent = () => (webhookListGeneration.get(channelId) ?? 0) === generation;

  const inflight = withFluxerRateLimit(async () => {
    const channel = fluxerClient.channels.get(channelId) ?? (await fluxerClient.channels.fetch(channelId));
    return  (channel).fetchWebhooks();
  }, `webhook:${channelId}`)
    .then(webhooks => {
      const ids = new Set(webhooks.map(x => x.id));
      if (isCurrent()) webhookListCache.set(channelId, { at: Date.now(), ids });
      return ids;
    })
    .catch(e => {
      if (isCurrent()) webhookListCache.set(channelId, { at: Date.now(), ids: new Set(), error: e });
      throw e;
    })
    .finally(() => {
      if (webhookListInflight.get(channelId) === inflight) webhookListInflight.delete(channelId);
    });

  webhookListInflight.set(channelId, inflight);
  return inflight;
}

export function invalidateFluxerWebhookCache(channelId) {
  if (!channelId) return;
  webhookListGeneration.set(channelId, (webhookListGeneration.get(channelId) ?? 0) + 1);
  webhookListCache.delete(channelId);
  webhookListInflight.delete(channelId);
}

/**
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {string} channelId
 * @param {string} webhookId
 */
export async function hasFluxerWebhook(fluxerClient, channelId, webhookId) {
  const cached = webhookListCache.get(channelId);
  if (cached && Date.now() - cached.at < WEBHOOK_CACHE_TTL_MS) {
    if (cached.error) throw cached.error;
    return cached.ids.has(webhookId);
  }
  const ids = await fetchFluxerWebhookIds(fluxerClient, channelId);
  return ids.has(webhookId);
}
