import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import Config from "./ConfigHandler.js";
import { log } from "./Logger.js";

const MIN_RATE_LIMIT_HOLD_MS = 1_000;
const FALLBACK_RETRY_AFTER_MS = 60_000;
const SERVER_ERROR_BACKOFF_MS = 15_000;
const IP_BAN_FALLBACK_MS = 30 * 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const MAX_TOTAL_WAIT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

const STRIKE_WINDOW_MS = 60_000;
const STRIKE_ESCALATION_THRESHOLD = MAX_ATTEMPTS + 2;

const STATE_FILE = Config.DataFolderPath + "/fluxer-ratelimit.json";

const queues = new Map();

function getQueueState(key) {
  let state = queues.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), nextAt: 0, loggedUntil: 0, strikes: [] };
    queues.set(key, state);
  }
  return state;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const GLOBAL_KEY = "__global__";

function loadPersistedHolds() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const stored = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    const now = Date.now();
    const ceiling = now + MAX_RETRY_AFTER_MS;
    let restored = 0;
    for (const [key, nextAt] of Object.entries(stored)) {
      if (typeof nextAt !== "number" || !Number.isFinite(nextAt) || nextAt <= now) continue;
      getQueueState(key).nextAt = Math.min(nextAt, ceiling);
      restored++;
    }
    if (restored > 0) {
      log("FLUXER", `Restored ${restored} active Fluxer rate limit hold${restored === 1 ? "" : "s"} from disk`);
    }
  } catch {}
}

let persistChain = Promise.resolve();
let persistQueued = false;

function persistHolds() {
  if (persistQueued) return;
  persistQueued = true;
  persistChain = persistChain.then(async () => {
    persistQueued = false;
    const now = Date.now();
    const out = {};
    for (const [key, state] of queues) {
      if (state.nextAt > now) out[key] = state.nextAt;
    }
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(out));
      await rename(temp, STATE_FILE);
    } catch {}
  });
}

loadPersistedHolds();

function isGlobalRateLimitError(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (current.global === true) return true;
    if (current.rawBody?.global === true) return true;
    if (String(current.headers?.["x-ratelimit-global"] ?? "").toLowerCase() === "true") return true;
  }
  return false;
}

export function fluxerRetryPolicy() {
  return 0;
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

function isFluxerServerError(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    const status = current.status ?? current.statusCode;
    if (status === 502 || status === 503 || status === 504) return true;
  }
  return false;
}

function isFluxerIpBanError(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if ((current.status ?? current.statusCode) !== 403) continue;
    const code = current.code ?? current.rawBody?.code;
    if (code === "GLOBAL_IP_TEMPORARILY_BANNED" || code === "GLOBAL_IP_BANNED") return true;
  }
  return false;
}

function ipBanHoldMs(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    const expiresAt = Date.parse(current.rawBody?.expires_at ?? current.expiresAt ?? "");
    if (!Number.isFinite(expiresAt)) continue;
    const remaining = expiresAt - Date.now();
    if (remaining > 0) return remaining;
  }
  return 0;
}

function clampHold(ms, floorMs) {
  return Math.min(Math.max(ms, floorMs), MAX_RETRY_AFTER_MS);
}

function recordStrike(state, now) {
  state.strikes = state.strikes.filter(at => now - at < STRIKE_WINDOW_MS);
  state.strikes.push(now);
  return state.strikes.length;
}

function logHold(state, until, message) {
  if (until <= state.loggedUntil + 5000) return;
  state.loggedUntil = until;
  log("FLUXER", message);
}

export function isFluxerRateLimited(key = "message") {
  const now = Date.now();
  return now < (queues.get(key)?.nextAt ?? 0) || now < (queues.get(GLOBAL_KEY)?.nextAt ?? 0);
}

export function noteFluxerRateLimit(error, key = "message") {
  const rateLimited = isFluxerRateLimitError(error);
  const ipBanned = !rateLimited && isFluxerIpBanError(error);
  const serverDown = !rateLimited && !ipBanned && isFluxerServerError(error);
  if (!rateLimited && !ipBanned && !serverDown) return false;

  const now = Date.now();

  if (ipBanned) {
    const state = getQueueState(GLOBAL_KEY);
    const waitMs = clampHold(ipBanHoldMs(error) || IP_BAN_FALLBACK_MS, MIN_RATE_LIMIT_HOLD_MS);
    const until = now + waitMs;
    state.nextAt = Math.max(state.nextAt, until);
    persistHolds();
    logHold(state, until, `Fluxer has blocked this IP, holding all requests for ${Math.ceil(waitMs / 1000)} seconds`);
    return true;
  }

  if (serverDown) {
    const state = getQueueState(key);
    const waitMs = clampHold(SERVER_ERROR_BACKOFF_MS, MIN_RATE_LIMIT_HOLD_MS);
    const until = now + waitMs;
    state.nextAt = Math.max(state.nextAt, until);
    persistHolds();
    logHold(state, until, `Fluxer backend is returning errors (${key}), backing off for ${Math.ceil(waitMs / 1000)} seconds`);
    return true;
  }

  const globalLimit = isGlobalRateLimitError(error);
  const targetKey = globalLimit ? GLOBAL_KEY : key;
  const state = getQueueState(targetKey);
  const retryAfter = rateLimitRetryAfter(error);
  const requestedMs = retryAfter > 0 ? retryAfter * 1000 : FALLBACK_RETRY_AFTER_MS;

  const strikes = recordStrike(state, now);
  const escalate = globalLimit || strikes >= STRIKE_ESCALATION_THRESHOLD;
  const waitMs = clampHold(escalate ? Math.max(requestedMs, FALLBACK_RETRY_AFTER_MS) : requestedMs, MIN_RATE_LIMIT_HOLD_MS);
  const until = now + waitMs;

  state.nextAt = Math.max(state.nextAt, until);
  if (escalate) {
    const globalState = getQueueState(GLOBAL_KEY);
    globalState.nextAt = Math.max(globalState.nextAt, until);
  }
  persistHolds();

  logHold(
    state,
    until,
    `Rate limited by Fluxer (${targetKey}), holding ${escalate ? "all requests" : "its requests"} for ${Math.ceil(waitMs / 1000)} seconds`
  );

  return true;
}

function rateLimitedError(key) {
  const error = new Error(`Fluxer requests for ${key} are paused by an active rate limit`);
  error.code = "FLUXER_LOCAL_WAIT_TIMEOUT";
  return error;
}

export async function withFluxerRateLimit(handler, key = "message") {
  const state = getQueueState(key);
  const globalState = getQueueState(GLOBAL_KEY);
  const deadline = Date.now() + MAX_TOTAL_WAIT_MS;

  const run = state.tail.then(async () => {
    for (let attempt = 1; ; attempt++) {
      const wait = Math.max(0, Math.max(state.nextAt, globalState.nextAt) - Date.now());
      if (wait > 0) {
        if (Date.now() + wait > deadline) throw rateLimitedError(key);
        await sleep(wait);
      }

      try {
        return await handler();
      } catch (error) {
        if (!noteFluxerRateLimit(error, key) || attempt >= MAX_ATTEMPTS) throw error;
        const retryWait = Math.max(0, Math.max(state.nextAt, globalState.nextAt) - Date.now());
        if (Date.now() + retryWait > deadline) throw error;
      }
    }
  });

  state.tail = run.catch(() => {});
  return run;
}
