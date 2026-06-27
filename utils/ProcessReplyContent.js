import truncate from "truncate";
import {
  removeLinkEmbeds,
  traverseMessageLinks,
} from "./EmojiStickerParser.js";
import { sanitizePings } from "./SanitizePings.js";
import { parseMentions } from "./MessageContentParser.js";

/**
 * @param {import("@fluxerjs/core").Message} message
 */
export async function processReplyContent(message) {
  if (message.content.trim().length === 0)
    if (message.stickers.length > 0) return "*Sticker*";
    else if (message.attachments.size > 0) return "*Attachment*";
    else return "*Empty message*";
  const firstProcess = (
    await traverseMessageLinks(await parseMentions(message))
  ).split("\n")[0];
  let secondProcess = removeLinkEmbeds(
    truncate(sanitizePings(firstProcess), 35),
  );
  if (!secondProcess.endsWith("…") && message.content.split("\n").length > 1) {
    secondProcess += "…";
  }
  return secondProcess;
}
