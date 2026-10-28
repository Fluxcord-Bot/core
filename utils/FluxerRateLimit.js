import { log } from "./Logger.js";

const FALLBACK_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 10 * 60_000;
const MAX_TOTAL_WAIT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

const queues = new Map();

function getQueueState(key) {
  let state = queues.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), nextAt: 0, loggedUntil: 0 };
    queues.set(key, state);
  }
  return state;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const GLOBAL_KEY = "__global__";

function isGlobalRateLimitError(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (current.global === true) return true;
    if (current.rawBody?.global === true) return true;
    if (String(current.headers?.["x-ratelimit-global"] ?? "").toLowerCase() === "true") return true;
  }
  return false;
}

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

export function isFluxerRateLimited(key = "message") {
  const now = Date.now();
  return now < (queues.get(key)?.nextAt ?? 0) || now < (queues.get(GLOBAL_KEY)?.nextAt ?? 0);
}

export function noteFluxerRateLimit(error, key = "message") {
  if (!isFluxerRateLimitError(error)) return false;

  const targetKey = isGlobalRateLimitError(error) ? GLOBAL_KEY : key;
  const state = getQueueState(targetKey);
  const retryAfter = rateLimitRetryAfter(error);
  const waitMs = Math.min(retryAfter > 0 ? retryAfter * 1000 : FALLBACK_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
  const until = Date.now() + waitMs;

  state.nextAt = Math.max(state.nextAt, until);
  if (until > state.loggedUntil + 5000) {
    state.loggedUntil = until;
    log("FLUXER", `Rate limited by Fluxer (${targetKey}), holding requests for ${Math.ceil(waitMs / 1000)} seconds`);
  }

  return true;
}

export async function withFluxerRateLimit(handler, key = "message") {
  const state = getQueueState(key);
  const globalState = getQueueState(GLOBAL_KEY);
  const deadline = Date.now() + MAX_TOTAL_WAIT_MS;

  const run = state.tail.then(async () => {
    const wait = Math.max(0, Math.max(state.nextAt, globalState.nextAt) - Date.now());
    if (wait > 0) await sleep(wait);

    for (let attempt = 1; ; attempt++) {
      try {
        return await handler();
      } catch (error) {
        if (!noteFluxerRateLimit(error, key) || attempt >= MAX_ATTEMPTS || Date.now() >= deadline) throw error;
      }
    }
  });

  state.tail = run.catch(() => {});
  return run;
}
