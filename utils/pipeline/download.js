import { log } from "../Logger.js";

export async function downloadFluxerAttachment(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 1) {
        log("FLUXER", `Failed to download Fluxer attachment ${url}`, e);
        return null;
      }
    }
  }
  return null;
}
