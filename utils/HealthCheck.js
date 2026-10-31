//@ts-check
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import Config from "./ConfigHandler.js";
import { log } from "./Logger.js";

/** @type {string | null} */
let version = null;
try {
  version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || null;
} catch {
  // no package.json next to utils/: leave the version out
}

/**
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @returns {import("node:http").Server | null}
 */
export function setupHealthcheck(discordClient, fluxerClient) {
  if (Config.HealthcheckEnabled === false) return null;

  const port = Config.HealthcheckPort ?? 8080;
  const host = Config.HealthcheckHost ?? "0.0.0.0";

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    if (req.method !== "GET" || (url !== "/health" && url !== "/live" && url !== "/ready")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not_found" }));
      return;
    }

    const discordOnline = isDiscordOnline(discordClient);
    const fluxerOnline = isFluxerOnline(fluxerClient);

    const healthy = url === "/live" ? true : discordOnline && fluxerOnline;

    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: healthy ? "ok" : "degraded",
        discord: discordOnline ? "online" : "offline",
        fluxer: fluxerOnline ? "online" : "offline",
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        ...(hasToken(req) ? details(discordClient, fluxerClient) : {}),
      })
    );
  });

  server.on("error", err => {
    log("META", `Healthcheck server failed on ${host}:${port}:`, err);
  });

  server.listen(port, host, () => {
    log("META", `Healthcheck listening on ${host}:${port} (/health)`);
  });

  return server;
}

/**
 * Whether the request carries the HealthcheckToken (as "Authorization: Bearer <token>").
 * @param {import("node:http").IncomingMessage} req
 */
function hasToken(req) {
  const token = Config.HealthcheckToken;
  if (!token) return false;
  const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(String(token));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/**
 * Extra stats for token holders: version, Discord latency/guilds/shards, Fluxer guilds.
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
function details(discordClient, fluxerClient) {
  /** @type {Record<string, any>} */
  const out = { version };
  try {
    const ping = discordClient.ws?.ping;
    out.latency_ms = typeof ping === "number" && ping >= 0 ? ping : null;
    out.guilds = discordClient.guilds?.cache?.size ?? null;
    out.shards = [...(discordClient.ws?.shards?.values?.() ?? [])].map(s => ({
      id: s.id,
      connected: s.status === 0, // Status.Ready
      latency_ms: typeof s.ping === "number" && s.ping >= 0 ? s.ping : null,
    }));
  } catch {
    // mid-reconnect: leave out what the client can't say
  }
  try {
    const guilds = /** @type {any} */ (fluxerClient.guilds);
    out.fluxer_guilds = typeof guilds?.size === "number" ? guilds.size : (guilds?.cache?.size ?? null);
  } catch {
    out.fluxer_guilds = null;
  }
  return out;
}

/** @param {import("discord.js").Client} client */
function isDiscordOnline(client) {
  try {
    if (typeof client.isReady === "function" && !client.isReady()) return false;
    const wsStatus = client.ws?.status;
    if (typeof wsStatus === "number" && wsStatus !== 0) return false;
    return !!client.user;
  } catch {
    return false;
  }
}

/** @param {import("@fluxerjs/core").Client} client */
function isFluxerOnline(client) {
  try {
    if (typeof client.isReady === "function") return !!client.isReady();
    return !!client.user;
  } catch {
    return false;
  }
}
