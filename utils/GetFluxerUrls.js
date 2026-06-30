import DefaultConfig from "./ConfigHandler.js";
import { log } from "./Logger.js";

let FLUXER_WELLKNOWN = {};

export async function getWellknownFluxer(attempt = 0) {
  if ("api_code_version" in FLUXER_WELLKNOWN) return FLUXER_WELLKNOWN;
  try {
    const res = await fetch(
      `${DefaultConfig.FluxerAPIBaseURL}/.well-known/fluxer`,
    );
    if (res.status > 399) throw new Error("Fetch returned non-2xx or 3xx code");
    const json = await res.json();
    FLUXER_WELLKNOWN = json;
    return json;
  } catch (e) {
    if (attempt >= 5) {
      return {
        endpoints: {
          webapp: "https://fluxer.app",
        },
      };
    }
    log(
      "FLUXER",
      `Can't fetch Fluxer well-known (attempt ${attempt + 1}/5): ${e}`,
    );
    return getWellknownFluxer(attempt + 1);
  }
}

export async function getFluxerUrls() {
  const json = await getWellknownFluxer();
  return json.endpoints;
}

export async function getFluxerWebappUrl() {
  const endpoints = await getFluxerUrls();
  return endpoints.webapp;
}

export async function getFluxerApiUrl() {
  const endpoints = await getFluxerUrls();
  return endpoints.api;
}
