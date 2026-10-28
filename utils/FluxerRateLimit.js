import { log } from "./Logger.js";

const FALLBACK_RETRY_AFTER_MS = 30_000;
const MAX_RETRY_AFTER_MS = 10 * 60_000;
const MAX_TOTAL_WAIT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

let cooldownUntil = 0;
let cooldownLoggedUntil = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function fluxerRetryPolicy({ method, routeKey }) {
  if (routeKey.endsWith("/typing") || routeKey.includes("/reactions/")) return 0;
  if (method.toUpperCase() === "POST") return 0;
  return 3;
}

function rateLimitRetryAfter(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    const retryAfter = Number(current?.retryAfter ?? current?.rawBody?.retry_after);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  }
  return 0;
}

export function isFluxerRateLimitError(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (current.code === "RATE_LIMITED" || current.status === 429 || current.statusCode === 429) return true;
  }
  return false;
}

export function isFluxerRateLimited() {
  return Date.now() < cooldownUntil;
}

export function noteFluxerRateLimit(error) {
  if (!isFluxerRateLimitError(error)) return false;

  const retryAfter = rateLimitRetryAfter(error);
  const waitMs = Math.min(retryAfter > 0 ? retryAfter * 1000 : FALLBACK_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
  const until = Date.now() + waitMs;

  if (until > cooldownUntil) cooldownUntil = until;
  if (until > cooldownLoggedUntil + 5000) {
    cooldownLoggedUntil = until;
    log("FLUXER", `Rate limited by Fluxer, holding requests for ${Math.ceil(waitMs / 1000)} seconds`);
  }

  return true;
}

export async function waitForFluxerCooldown(deadline = Date.now() + MAX_TOTAL_WAIT_MS) {
  while (isFluxerRateLimited()) {
    const remaining = Math.min(cooldownUntil - Date.now(), deadline - Date.now());
    if (remaining <= 0) return;
    await sleep(remaining);
  }
}

export async function withFluxerRateLimit(handler) {
  const deadline = Date.now() + MAX_TOTAL_WAIT_MS;

  for (let attempt = 1; ; attempt++) {
    await waitForFluxerCooldown(deadline);
    try {
      return await handler();
    } catch (error) {
      if (!noteFluxerRateLimit(error) || attempt >= MAX_ATTEMPTS || Date.now() >= deadline) throw error;
    }
  }
}