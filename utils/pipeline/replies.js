import { MessageLink } from "../../db/index.js";
import { findLinkSiblings } from "../Bridging.js";
import { processReplyContent } from "../ProcessReplyContent.js";
import { indicatorPrefix } from "../NameIndicator.js";
import { resolveUsername } from "../MentionResolver.js";
import { replyLineForPlatform } from "./emojiCfg.js";

export async function findReplyCopy(targetChannelId, refMessageId) {
  if (!refMessageId) return null;
  const refLink = await MessageLink.findOne({ where: { messageId: refMessageId } });
  if (!refLink) return null;
  const siblings = await findLinkSiblings(refLink.linkGroup);
  return siblings.find(s => s.endpoint?.channelId === targetChannelId) ?? null;
}

function authorLabelFor(refMessage, targetPlatform, nameIndicator, authorPlatform) {
  const author = refMessage?.author;
  if (refMessage?.webhookId) {
    const name = author?.globalName ?? author?.username ?? "";
    if (/^\[[^\]]+\]/.test(name)) {
      return targetPlatform === "discord" ? name : `@${name}`;
    }
  }
  if (targetPlatform === "discord") {
    return `${indicatorPrefix(authorPlatform, nameIndicator)}${author?.tag ?? author?.username ?? "unknown-user"}`;
  }
  const disc = author?.discriminator;
  return `${indicatorPrefix(authorPlatform, nameIndicator)}@${author?.username ?? "unknown-user"}${disc && disc !== "0000" ? `#${disc}` : ""}`;
}

async function discordReplyPing(target, refMessageId, refMessage) {
  const client = target.discordClient;
  if (!client) return null;
  const local = await findReplyCopy(target.channelId, refMessageId).catch(() => null);
  if (local?.endpoint?.platform === "discord") {
    try {
      const channel = await client.channels.fetch(local.endpoint.channelId);
      const msg = await channel.messages.fetch(local.messageId);
      if (msg?.author?.id && !msg.webhookId) return msg.author.id;
    } catch {}
  }
  if (target.sourcePlatform === "discord" && refMessage?.author?.id && !refMessage?.webhookId) {
    return refMessage.author.id;
  }
  if (refMessage?.author?.username && target.discordGuild) {
    const member = await resolveUsername(
      target.discordGuild,
      refMessage.author.username,
      refMessage.author.discriminator
    ).catch(() => null);
    const id = member?.user?.id ?? member?.id;
    if (id) return id;
  }
  return null;
}

export async function renderReplyLine(target, refMessageId, refMessage) {
  if (!refMessageId) return "";
  const prefix = replyLineForPlatform(target.platform, target.instanceId);
  let label = authorLabelFor(refMessage, target.platform, target.nameIndicator, target.sourcePlatform ?? target.platform);
  if (target.platform === "discord") {
    const ping = await discordReplyPing(target, refMessageId, refMessage);
    if (ping) label = `<@${ping}>`;
  }
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
