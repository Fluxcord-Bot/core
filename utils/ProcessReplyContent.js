import truncate from "truncate";
import { removeLinkEmbeds } from "./EmojiStickerParser.js";
import { sanitizePings } from "./SanitizePings.js";

/**
 * @param {string} content
 */
export function processReplyContent(content) {
  const firstProcess = content.split("\n")[0];
  let secondProcess = removeLinkEmbeds(
    truncate(sanitizePings(firstProcess), 25),
  );
  if (!secondProcess.endsWith("...") && firstProcess.length > 1) {
    secondProcess += "...";
  }
  return secondProcess;
}
