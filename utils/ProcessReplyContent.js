import truncate from "truncate";
import { flattenMarkdownLinks, removeLinkEmbeds, sanitizeLinks, traverseMessageLinks } from "./EmojiStickerParser.js";
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
  const firstProcess = (await traverseMessageLinks(await parseMentions(message))).split("\n")[0];
  const cleaned = flattenMarkdownLinks(sanitizeLinks(sanitizePings(firstProcess))).replace(/<a?:([^:\s]+):\d+>/g, ":$1:");
  const truncated = truncate(cleaned, 35);
  let secondProcess = truncated;
  if (truncated !== cleaned) {
    secondProcess = secondProcess.replace(/<[^<>]*…$/, "").replace(/[\s\u200b]+$/, "");
    if (!secondProcess.endsWith("…")) secondProcess += "…";
  }
  if (!secondProcess.endsWith("…") && message.content.split("\n").length > 1) {
    secondProcess += "…";
  }
  secondProcess = secondProcess.replace(/^[\s\u200b]*@+[\s\u200b]*/, "");
  return secondProcess;
}
