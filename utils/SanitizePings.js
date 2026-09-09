/**
 * Sanitizes everyone, here and role mentions so they don't trigger when bridged (STUPID WEBHOOK SHIT)
 *
 * @param {string} content
 * @param {boolean} userHasPingPerms
 * @returns {string}
 */
export function sanitizePings(content, userHasPingPerms = false) {
  let res = content;

  if (!userHasPingPerms)
    res = content
      .replaceAll("@everyone", "@\u200beveryone")
      .replaceAll("@here", "@\u200bhere");

  return res;
}
