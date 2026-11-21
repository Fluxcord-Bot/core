import { Message as DiscordMessage } from "discord.js";
import { Message as FluxerMessage, PartialMessage as FluxerPartialMessage } from "@fluxerjs/core";
import { isDiscordSpoilerAttachment, isFluxerSpoilerAttachment } from "../SpoilerAttachments.js";

export const DISCORD_SKIP_TYPES = new Set([4, 5, 6, 18, 21, 22, 23, 24]);

const FLUXER_SKIP_TYPES = new Set([4, 5, 6, 18, 21]);

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

function normalizeReference(message) {
  const ref = message.reference ?? message.messageReference;
  if (!ref) return null;
  return {
    messageId: ref.messageId ?? null,
    type: ref.type ?? 0,
    forwarded: ref.type === 1,
  };
}

function messageFlags(message) {
  return {
    crosspost: message.flags?.has?.(2) ?? false,
    suppressEmbeds: message.flags?.has?.(4) ?? false,
    silent: message.flags?.has?.(4096) ?? false,
  };
}

function forwardedSnapshotOf(message) {
  if ((message.reference ?? message.messageReference)?.type !== 1) return null;
  const snapshots = message.messageSnapshots;
  return snapshots?.first?.() ?? snapshots?.[0] ?? null;
}

const countOf = x => x?.size ?? x?.length ?? 0;

function payloadSourceOf(message, snapshot) {
  const hasPayload =
    snapshot &&
    (snapshot.content || countOf(snapshot.attachments) || countOf(snapshot.embeds) || countOf(snapshot.stickers));
  return hasPayload ? snapshot : message;
}

function fromPlatform(platform, message, options = {}) {
  const snapshot = forwardedSnapshotOf(message);
  const source = payloadSourceOf(message, snapshot);
  return {
    platform,
    instanceId: options.instanceId ?? "default",
    raw: message,
    id: message.id,
    guildId: message.guildId ?? null,
    channelId: message.channelId,
    author: normalizeAuthor(message.author),
    member: message.member ?? null,
    webhookId: message.webhookId ?? null,
    content: source.content ?? "",
    attachments: (source.attachments ?? []).map(a => normalizeAttachment(a, platform)),
    embeds: source.embeds ?? [],
    stickers: source.stickers ?? [],
    reference: normalizeReference(message),
    forwardedSnapshot: snapshot,
    flags: messageFlags(message),
    type: message.type ?? 0,
    interaction: platform === "discord" ? (message.interaction ?? null) : null,
    channel: message.channel ?? null,
    guild: message.guild ?? null,
    client: message.client,
  };
}

export function fromFluxerPartial(message, options = {}) {
  return {
    platform: "fluxer",
    instanceId: options.instanceId ?? "default",
    raw: message,
    id: message.id,
    guildId: message.guildId ?? null,
    channelId: message.channelId,
    author: normalizeAuthor(message.author),
    member: null,
    webhookId: null,
    content: message.content ?? "",
    attachments: [],
    embeds: [],
    stickers: [],
    reference: null,
    forwardedSnapshot: null,
    flags: { crosspost: false, suppressEmbeds: false, silent: false },
    type: 0,
    interaction: null,
    channel: message.channel ?? null,
    guild: null,
    client: message.client,
  };
}

export function normalizeMessage(message, options = {}) {
  if (message instanceof DiscordMessage) return fromPlatform("discord", message, options);
  if (message instanceof FluxerMessage) return fromPlatform("fluxer", message, options);
  if (message instanceof FluxerPartialMessage) return fromFluxerPartial(message, options);
  return null;
}
