export function normalizeFcJson(json) {
  let j = json;
  /** @type {string} */
  let l = j.fluxerReplyEmoji.replyL;
  /** @type {string} */
  let r = j.fluxerReplyEmoji.replyR;
  if (!l.startsWith(":")) l = ":" + l;
  if (!r.startsWith(":")) r = ":" + r;
  return {
    ...j,
    fluxerReplyEmoji: {
      replyL: l,
      replyR: r,
    },
  };
}
