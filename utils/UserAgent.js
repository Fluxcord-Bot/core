import pkg from "../package.json" with { type: "json" };

function parseVer(ver) {
  return ver ? "/" + ver.replace(/^[^\d]+/, "") : "";
}

export function buildDiscordUserAgentSuffix() {
  return `Fluxcord/${pkg.version} (https://fluxcord.jbcrn.dev)`;
}

export function buildFluxerUserAgent() {
  return `Fluxcord/${pkg.version} (https://fluxcord.jbcrn.dev) fluxerjs${parseVer(pkg.dependencies["@fluxerjs/core"])} (https://fluxer.js.org)`;
}

export function buildExtHttpUserAgent() {
  return `Fluxcord/${pkg.version} (https://fluxcord.jbcrn.dev; +fluxcord@jbcrn.dev)`;
}
