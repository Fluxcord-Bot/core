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

async function findReplySiblings(refMessageId) {
  if (!refMessageId) return [];
  const refLink = await MessageLink.findOne({ where: { messageId: refMessageId } });
  if (!refLink) return [];
  return await findLinkSiblings(refLink.linkGroup);
}

function refOriginPlatform(target, refMessage) {
  if (!refMessage) return null;
  if (refMessage.webhookId) return "discord";
  return target.sourcePlatform ?? target.platform;
}

function stripIndicatorPrefix(name) {
  return String(name ?? "").replace(/^\[[^\]]+\]\s*/, "");
}

function authorLabelFor(refMessage, targetPlatform, nameIndicator, originPlatform) {
  const author = refMessage?.author;
  if (refMessage?.webhookId) {
    const name = author?.globalName ?? author?.username ?? "";
    if (/^\[[^\]]+\]/.test(name)) {
      return targetPlatform === "discord" ? name : `@${name}`;
    }
  }
  if (targetPlatform === "discord") {
    return `${indicatorPrefix(originPlatform, nameIndicator)}${author?.tag ?? author?.username ?? "unknown-user"}`;
  }
  const disc = author?.discriminator;
  return `${indicatorPrefix(originPlatform, nameIndicator)}@${author?.username ?? "unknown-user"}${disc && disc !== "0000" ? `#${disc}` : ""}`;
}

async function discordReplyPing(target, refMessageId, refMessage, originPlatform) {
  const client = target.discordClient;
  if (!client) return null;
  const siblings = await findReplySiblings(refMessageId).catch(() => []);
  const discordCopy = siblings.find(s => s.endpoint?.platform === "discord");
  if (discordCopy) {
    try {
      const channel = await client.channels.fetch(discordCopy.endpoint.channelId);
      const msg = await channel.messages.fetch(discordCopy.messageId);
      if (msg?.author?.id && !msg.webhookId) return msg.author.id;
    } catch {}
  }
  if (target.sourcePlatform === "discord" && refMessage?.author?.id && !refMessage?.webhookId) {
    return refMessage.author.id;
  }
  if (originPlatform === "discord" && refMessage?.author?.username && discordCopy?.endpoint?.guildId) {
    const originalGuild = await client.guilds.fetch(discordCopy.endpoint.guildId).catch(() => null);
    const name = stripIndicatorPrefix(refMessage.author.username);
    if (originalGuild && name) {
      const member = await resolveUsername(originalGuild, name, refMessage.author.discriminator).catch(() => null);
      const id = member?.user?.id ?? member?.id;
      if (id) return id;
    }
  }
  return null;
}

function discordUrlFor(endpoint, messageId) {
  if (!endpoint || !messageId) return null;
  return `https://discord.com/channels/${endpoint.guildId}/${endpoint.channelId}/${messageId}`;
}

export async function renderReplyLine(target, refMessageId, refMessage) {
  if (!refMessageId) return "";
  const prefix = replyLineForPlatform(target.platform, target.instanceId);
  const originPlatform = refOriginPlatform(target, refMessage) ?? target.platform;
  let label = authorLabelFor(refMessage, target.platform, target.nameIndicator, originPlatform);
  if (target.platform === "discord") {
    const ping = await discordReplyPing(target, refMessageId, refMessage, originPlatform);
    if (ping) label = `<@${ping}>`;
  }
  const body = refMessage ? await processReplyContent(refMessage) : "*original message*";

  const siblings = await findReplySiblings(refMessageId).catch(() => []);
  const discordCopy = siblings.find(s => s.endpoint?.platform === "discord");
  const local = await findReplyCopy(target.channelId, refMessageId);

  if (local) {
    if (target.platform === "fluxer") return `${prefix}${label}:\n`;
    const url = discordUrlFor(discordCopy?.endpoint, discordCopy?.messageId);
    if (url) return `${prefix}${label}: [${body}](<${url}>)\n`;
    return `${prefix}${label}: ${body}\n`;
  }

  if (refMessage) {
    if (target.platform === "fluxer") return `${prefix}${label}: ${body}\n`;
    const url =
      discordUrlFor(discordCopy?.endpoint, discordCopy?.messageId) ??
      (target.sourcePlatform === "discord"
        ? discordUrlFor({ guildId: refMessage?.guildId, channelId: refMessage?.channelId }, refMessage?.id)
        : null);
    if (url) return `${prefix}${label}: [${body}](<${url}>)\n`;
    return `${prefix}${label}: ${body}\n`;
  }

  return `${prefix}Unbridged message\n`;
}
