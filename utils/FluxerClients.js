import { Client as FluxerClient, Events as FluxerEvents } from "@fluxerjs/core";
import Config, { getFluxerInstances } from "./ConfigHandler.js";
import { buildFluxerUserAgent } from "./UserAgent.js";
import { fluxerRetryPolicy } from "./FluxerRateLimit.js";
import { log } from "./Logger.js";

const fluxerSelfHealingCloseCodes = new Set([4000, 4007, 4008, 4009, 4012, 4013]);
const fluxerUnrecoverableCloseCodes = new Set([4004, 4010, 4011]);

/**
 * @type {Map<string, FluxerClient>}
 */
export const fluxerClients = new Map();

/**
 * @type {FluxerClient}
 */
export let defaultFluxerClient =  (undefined);

/**
 * @type {Map<string, string>}
 */
export const fluxerBotUserToInstance = new Map();

/**
 * @param {string | undefined | null} instanceId
 * @returns {FluxerClient | undefined}
 */
export function getFluxerClient(instanceId) {
  return fluxerClients.get(instanceId);
}

/**
 * @param {string | undefined | null} instanceId
 * @returns {FluxerClient}
 */
export function resolveFluxerClient(instanceId) {
  if (!instanceId) {
    return defaultFluxerClient;
  }
  const client = fluxerClients.get(instanceId);
  if (!client) {
    throw new Error(
      `Unknown Fluxer instance "${instanceId}". Running instances: ${[...fluxerClients.keys()].join(", ")}`
    );
  }
  return client;
}

/**
 * @param {FluxerClient | undefined | null} client
 * @returns {string | null}
 */
export function instanceIdOfClient(client) {
  if (!client) return null;
  for (const [instanceId, c] of fluxerClients) {
    if (c === client) return instanceId;
  }
  return null;
}

/**
 * @param {(instanceId: string, client: FluxerClient) => void} wireEvents
 * @param {(mapsCount: number) => string} presenceText
 */
export async function setupFluxerClients(wireEvents, presenceText) {
  const instances = getFluxerInstances();

  for (const inst of instances) {
    const client = new FluxerClient({
      rest: {
        api: inst.FluxerAPIBaseURL,
        userAgent: buildFluxerUserAgent(),
        retryPolicy: fluxerRetryPolicy,
      },
      ...(inst.discovery ? { discovery: inst.discovery } : {}),
      ...(inst.instance ? { instance: inst.instance } : {}),
      cache: {
        guilds: Infinity,
        channels: Infinity,
      },
    });

    client.on(FluxerEvents.Error, error => {
      log("FLUXER", `[${inst.id}]`, error);
    });

    attachGatewaySelfHealing(client, inst.id);

    fluxerClients.set(inst.id, client);
    wireEvents(inst.id, client);

    client.login(inst.token).catch(e => {
      log("FLUXER", `[${inst.id}] Login failed retrying in 15 seconds`, e);
      setTimeout(() => resetFluxerGateway(inst.id), 15000);
    });
  }

  defaultFluxerClient = fluxerClients.get("default") ?? [...fluxerClients.values()][0];
}

const resetting = new Set();

/**
 * @param {string} instanceId
 */
export async function resetFluxerGateway(instanceId) {
  const client = fluxerClients.get(instanceId);
  if (!client || resetting.has(instanceId)) return;
  resetting.add(instanceId);
  try {
    await client.destroy();
    await client.login(getFluxerInstanceToken(instanceId));
    log("FLUXER", `[${instanceId}] Gateway reconnected`);
  } catch (e) {
    log("FLUXER", `[${instanceId}] Gateway reconnect failed, retrying in 30 seconds`, e);
    setTimeout(() => resetFluxerGateway(instanceId), 30000);
  } finally {
    setTimeout(() => resetting.delete(instanceId), 10000);
  }
}

function getFluxerInstanceToken(instanceId) {
  const inst = getFluxerInstances().find(i => i.id === instanceId);
  return inst?.token ?? Config.FluxerBotToken;
}

/**
 * @param {FluxerClient} client
 * @param {string} instanceId
 */
function attachGatewaySelfHealing(client, instanceId) {
  client.on(FluxerEvents.ShardDisconnect, (shardId, code) => {
    if (fluxerUnrecoverableCloseCodes.has(code)) {
      log("FLUXER", `[${instanceId}] Gateway closed with unrecoverable code ${code}, not reconnecting`);
      return;
    }
    if (code < 4000 || fluxerSelfHealingCloseCodes.has(code)) return;
    log("FLUXER", `[${instanceId}] Gateway disconnected (code ${code ?? "unknown"}), reconnecting in 5 seconds`);
    setTimeout(() => resetFluxerGateway(instanceId), 5000);
  });
}

const gatewayStrikes = new Map();

export function checkFluxerConnections() {
  for (const [instanceId, client] of fluxerClients) {
    let everReady = false;
    try {
      everReady = client.isReady() || client.ws?.getShards?.().some(s => s.status === 2);
    } catch {}
    if (!everReady) {
      continue;
    }
    let alive = false;
    const shards = client.ws?.getShards?.();
    if (shards && shards.size > 0) {
      for (const shard of shards.values()) {
        if (shard.status === 2) {
          alive = true;
          break;
        }
      }
    } else {
      alive = client.isReady();
    }
    if (alive) {
      gatewayStrikes.set(instanceId, 0);
      continue;
    }
    const strikes = (gatewayStrikes.get(instanceId) ?? 0) + 1;
    gatewayStrikes.set(instanceId, strikes);
    log("META", `[${instanceId}] Fluxer gateway looks down (check ${strikes}/3)`);
    if (strikes >= 3) {
      gatewayStrikes.set(instanceId, 0);
      void resetFluxerGateway(instanceId);
    }
  }
}
