/**
 * Sanitizes @everyone, @here and role mentions so they don't trigger when bridged (STUPID WEBHOOK SHIT)
 *
 * @param {string} content
 * @returns {string}
 */
export function sanitizePings(content) {
  return content
    .replaceAll("@everyone", "@\u200beveryone")
    .replaceAll("@here", "@\u200bhere")
    .replace(/<@&\d+>/g, "@unknown-role");
}
