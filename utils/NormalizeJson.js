export function normalizeFcJson(json) {
  const raw = json?.fluxerReplyEmoji;
  let map = {};
  if (raw && typeof raw === "object") {
    if (raw.replyL || raw.replyR) {
      map.default = normalizeReplyEntry(raw);
    } else {
      for (const [instanceId, entry] of Object.entries(raw)) {
        map[instanceId] = normalizeReplyEntry(entry);
      }
    }
  }
  return {
    ...json,
    fluxerReplyEmoji: map,
  };
}

function normalizeReplyEntry(entry) {
  /** @type {string} */
  let l = entry?.replyL ?? "";
  /** @type {string} */
  let r = entry?.replyR ?? "";
  if (l && !l.startsWith(":")) l = ":" + l;
  if (r && !r.startsWith(":")) r = ":" + r;
  return { replyL: l, replyR: r };
}
