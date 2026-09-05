//@ts-check
import http from "node:http";
import Config from "./ConfigHandler.js";
import { log } from "./Logger.js";

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

    if (
      req.method !== "GET" ||
      (url !== "/health" && url !== "/live" && url !== "/ready")
    ) {
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
      }),
    );
  });

  server.on("error", (err) => {
    log("META", `Healthcheck server failed on ${host}:${port}:`, err);
  });

  server.listen(port, host, () => {
    log("META", `Healthcheck listening on ${host}:${port} (/health)`);
  });

  return server;
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
