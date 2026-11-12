import DefaultConfig, { getFluxerInstanceConfig } from "./ConfigHandler.js";
import { log } from "./Logger.js";

const WELLKNOWN_CACHE = new Map();

/**
 * @param {string} [instanceId]
 * @param {number} [attempt]
 */
export async function getWellknownFluxer(instanceId = "default", attempt = 0) {
  const cached = WELLKNOWN_CACHE.get(instanceId);
  if (cached && "api_code_version" in cached) return cached;

  const apiBase = getFluxerInstanceConfig(instanceId).FluxerAPIBaseURL;
  try {
    const res = await fetch(`${apiBase}/.well-known/fluxer`);
    if (res.status > 399) throw new Error("Fetch returned non-2xx or 3xx code");
    const json = await res.json();
    WELLKNOWN_CACHE.set(instanceId, json);
    return json;
  } catch (e) {
    if (attempt >= 5) {
      return {
        endpoints: {
          webapp: "https://fluxer.app",
        },
      };
    }
    log("FLUXER", `[${instanceId}] Can't fetch Fluxer well-known (attempt ${attempt + 1}/5): ${e}`);
    return getWellknownFluxer(instanceId, attempt + 1);
  }
}

/**
 * @param {string} [instanceId]
 */
export async function getFluxerUrls(instanceId = "default") {
  const json = await getWellknownFluxer(instanceId);
  return json.endpoints;
}

/**
 * @param {string} [instanceId]
 */
export async function getFluxerWebappUrl(instanceId = "default") {
  const endpoints = await getFluxerUrls(instanceId);
  return endpoints.webapp;
}

/**
 * @param {string} [instanceId]
 */
export async function getFluxerApiUrl(instanceId = "default") {
  const endpoints = await getFluxerUrls(instanceId);
  return endpoints.api;
}

/**
 * @param {string} [instanceId]
 */
export async function getFluxerMediaBaseUrl(instanceId = "default") {
  const endpoints = await getFluxerUrls(instanceId);
  return endpoints.media;
}

/**
 * @param {string} [instanceId]
 */
export async function getFluxerInviteBaseUrl(instanceId = "default") {
  const endpoints = await getFluxerUrls(instanceId);
  return endpoints.invite;
}

void DefaultConfig;
