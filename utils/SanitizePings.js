/**
 * Sanitizes @everyone and @here mentions by inserting a zero-width space
 * so they don't trigger mass pings when bridged.
 *
 * @param {string} content
 * @returns {string}
 */
export function sanitizePings(content) {
  return content
    .replaceAll("@everyone", "@\u200beveryone")
    .replaceAll("@here", "@\u200bhere");
}
