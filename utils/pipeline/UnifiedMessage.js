import { Message as DiscordMessage } from "discord.js";
import { Message as FluxerMessage } from "@fluxerjs/core";
import { isDiscordSpoilerAttachment, isFluxerSpoilerAttachment } from "../SpoilerAttachments.js";

export const DISCORD_SKIP_TYPES = new Set([4, 5, 6, 18, 21, 22, 23, 24]);

const FLUXER_SKIP_TYPES = new Set([4, 5, 6, 18]);

export function shouldSkipMessageType(platform, type) {
  if (type == null) return false;
  return platform === "discord" ? DISCORD_SKIP_TYPES.has(type) : FLUXER_SKIP_TYPES.has(type);
}

function normalizeAuthor(author) {
  if (!author) return null;
  return {
    id: author.id,
    username: author.username ?? "unknown",
    discriminator: author.discriminator ?? "0000",
    globalName: author.globalName ?? null,
    bot: Boolean(author.bot),
  };
}

function normalizeAttachment(attachment, platform) {
  const name = attachment.filename ?? attachment.name ?? "file";
  return {
    url: attachment.url,
    proxyUrl: attachment.proxyUrl ?? attachment.url,
    filename: name,
    size: attachment.size ?? 0,
    description: attachment.description ?? null,
    spoiler: platform === "discord" ? isDiscordSpoilerAttachment(attachment) : isFluxerSpoilerAttachment(attachment),
  };
}

function discordReference(message) {
  const ref = message.messageReference;
  if (!ref) return null;
  return {
    messageId: ref.messageId ?? null,
    type: ref.type ?? 0,
    forwarded: ref.type === 1,
  };
}

function fluxerReference(message) {
  const ref = message.messageReference;
  if (!ref) return null;
  return {
    messageId: ref.messageId ?? null,
    type: ref.type ?? 0,
    forwarded: ref.type === 1,
  };
}

function discordFlags(message) {
  return {
    crosspost: message.flags?.has?.(2) ?? false,
    suppressEmbeds: message.flags?.has?.(4) ?? false,
    silent: message.flags?.has?.(4096) ?? false,
  };
}

function fluxerFlags(message) {
  return {
    crosspost: message.flags?.has?.(2) ?? false,
    suppressEmbeds: message.flags?.has?.(4) ?? false,
    silent: message.flags?.has?.(4096) ?? false,
  };
}

export function fromDiscord(message, options = {}) {
  return {
    platform: "discord",
    instanceId: options.instanceId ?? "default",
    raw: message,
    id: message.id,
    guildId: message.guildId ?? null,
    channelId: message.channelId,
    author: normalizeAuthor(message.author),
    member: message.member ?? null,
    webhookId: message.webhookId ?? null,
    content: message.content ?? "",
    attachments: (message.attachments ?? []).map(a => normalizeAttachment(a, "discord")),
    embeds: message.embeds ?? [],
    stickers: message.stickers ?? [],
    reference: discordReference(message),
    forwardedSnapshot: message.messageReference?.type === 1 ? (message.messageSnapshots?.[0] ?? null) : null,
    flags: discordFlags(message),
    type: message.type ?? 0,
    interaction: message.interaction ?? null,
    channel: message.channel ?? null,
    guild: message.guild ?? null,
    client: message.client,
  };
}

export function fromFluxer(message, options = {}) {
  return {
    platform: "fluxer",
    instanceId: options.instanceId ?? "default",
    raw: message,
    id: message.id,
    guildId: message.guildId ?? null,
    channelId: message.channelId,
    author: normalizeAuthor(message.author),
    member: message.member ?? null,
    webhookId: message.webhookId ?? null,
    content: message.content ?? "",
    attachments: (message.attachments ?? []).map(a => normalizeAttachment(a, "fluxer")),
    embeds: message.embeds ?? [],
    stickers: message.stickers ?? [],
    reference: fluxerReference(message),
    forwardedSnapshot: message.messageReference?.type === 1 ? (message.messageSnapshots?.[0] ?? null) : null,
    flags: fluxerFlags(message),
    type: message.type ?? 0,
    interaction: null,
    channel: message.channel ?? null,
    guild: message.guild ?? null,
    client: message.client,
  };
}

export function normalizeMessage(message, options = {}) {
  if (message instanceof DiscordMessage) return fromDiscord(message, options);
  if (message instanceof FluxerMessage) return fromFluxer(message, options);
  return null;
}
