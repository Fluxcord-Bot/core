import { MessageLink } from "../../db/index.js";
import { findLinkSiblings } from "../Bridging.js";
import { processReplyContent } from "../ProcessReplyContent.js";
import { indicatorPrefix } from "../NameIndicator.js";
import { replyLineForPlatform } from "./emojiCfg.js";

export async function findReplyCopy(targetChannelId, refMessageId) {
  if (!refMessageId) return null;
  const refLink = await MessageLink.findOne({ where: { messageId: refMessageId } });
  if (!refLink) return null;
  const siblings = await findLinkSiblings(refLink.linkGroup);
  return siblings.find(s => s.endpoint?.channelId === targetChannelId) ?? null;
}

function authorLabelFor(refMessage, targetPlatform, nameIndicator) {
  const author = refMessage?.author;
  if (targetPlatform === "discord") {
    return `${indicatorPrefix("discord", nameIndicator)}${author?.tag ?? author?.username ?? "unknown-user"}`;
  }
  const disc = author?.discriminator;
  return `${indicatorPrefix("fluxer", nameIndicator)}@${author?.username ?? "unknown-user"}${disc && disc !== "0000" ? `#${disc}` : ""}`;
}

export async function renderReplyLine(target, refMessageId, refMessage) {
  if (!refMessageId) return "";
  const prefix = replyLineForPlatform(target.platform, target.instanceId);
  const label = authorLabelFor(refMessage, target.platform, target.nameIndicator);
  const body = refMessage ? await processReplyContent(refMessage) : "*original message*";

  const local = await findReplyCopy(target.channelId, refMessageId);
  if (local) {
    const localPlatform = local.endpoint?.platform ?? target.platform;
    if (target.platform === "fluxer") {
      return `${prefix}${label}:\n`;
    }
    const url =
      localPlatform === "discord"
        ? `https://discord.com/channels/${local.endpoint.guildId}/${local.endpoint.channelId}/${local.messageId}`
        : `https://discord.com/channels/${target.guildId}/${target.channelId}/${refMessage.id}`;
    return `${prefix}${label}: [${body}](<${url}>)\n`;
  }

  if (refMessage) {
    if (target.platform === "fluxer") {
      return `${prefix}${label}: ${body}\n`;
    }
    const url = `https://discord.com/channels/${target.guildId}/${target.channelId}/${refMessage.id}`;
    return `${prefix}${label}: [${body}](<${url}>)\n`;
  }

  return `${prefix}Unbridged message\n`;
}
