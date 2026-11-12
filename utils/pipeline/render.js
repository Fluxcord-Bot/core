import { MessageType, MessageFlags } from "discord.js";
import { replyLineForPlatform } from "./emojiCfg.js";
import { renderReplyLine, findReplyCopy } from "./replies.js";
import { parseMentions } from "../MessageContentParser.js";
import { sanitizePings } from "../SanitizePings.js";
import { resolveMentions } from "../MentionResolver.js";
import {
  parseDiscordEmojiToFluxer,
  parseFluxerEmojiToDiscord,
  parseFluxerEmojiToFluxer,
  traverseMessageLinks,
} from "../EmojiStickerParser.js";
import { discordEmbedToFluxer, fluxerEmbedToDiscord, isPlatformPreviewEmbed } from "../EmbedConverter.js";
import { refreshDiscordCdnLinks } from "../CdnLinkRefresher.js";
import { processSticker } from "../StickerProcessor.js";
import { cloudUploadAttachments } from "../CloudUpload.js";
import { checkEmbedPerms, checkPingPerms } from "../CheckManageServerPerms.js";
import { isBridgeToggleEnabled } from "../BridgeToggle.js";
import { resolveNameIndicator, indicatorPrefix, withIndicator } from "../NameIndicator.js";
import { getFluxerMediaBaseUrl } from "../GetFluxerUrls.js";
import { getFluxerInstanceConfig } from "../ConfigHandler.js";
import { resolveFluxerClient } from "../FluxerClients.js";
import { isDiscordSpoilerAttachment, toDiscordSpoilerFilename, SPOILER_ATTACHMENT_FLAG } from "../SpoilerAttachments.js";
import { downloadFluxerAttachment } from "./download.js";
import Config from "../ConfigHandler.js";
import { log } from "../Logger.js";

export const DISCORD_MAX_ATTACHMENT_SIZE = 24999900;
export const FLUXER_MAX_ATTACHMENT_SIZE = 19999000;

function sourceIsWebhook(umsg) {
  return Boolean(umsg.webhookId);
}

async function sourcePermissions(umsg, ctx) {
  if (!umsg.guildId || !umsg.author) return { canUserPing: true, canUserEmbed: true };
  const client = umsg.client;
  const canUserPing = await checkPingPerms(umsg.guildId, umsg.author.id, client);
  const canUserEmbed = sourceIsWebhook(umsg) ? true : await checkEmbedPerms(umsg.guildId, umsg.channelId, umsg.author.id, client);
  return { canUserPing, canUserEmbed };
}

async function everyonePingEnabled(targetEndpoint) {
  try {
    return await isBridgeToggleEnabled(targetEndpoint, "everyonePingEnabled");
  } catch {
    return true;
  }
}

function sourceAuthorTag(umsg) {
  const a = umsg.raw?.author;
  if (!a) return "unknown-user";
  return a.tag ?? `${a.username}${a.discriminator && a.discriminator !== "0000" ? `#${a.discriminator}` : ""}`;
}

function attachmentUrl(attachment) {
  return attachment.proxyURL ?? attachment.proxyUrl ?? attachment.url ?? "";
}

export async function renderIdentity(umsg, nameIndicator) {
  if (!umsg.author) return { username: "Fluxcord", avatarURL: undefined };
  if (umsg.platform === "fluxer") {
    const username = withIndicator(umsg.author.globalName ?? umsg.author.username, "fluxer", nameIndicator);
    const mediaBase = (await getFluxerMediaBaseUrl(umsg.instanceId).catch(() => undefined)) ?? Config.FluxerCDNBaseURL;
    const avatar = umsg.raw?.author?.avatar;
    let avatarURL;
    if (avatar) {
      const cdnBase = String(mediaBase).replace(/\/$/, "");
      const extension = avatar.startsWith("a_") ? "gif" : "webp";
      avatarURL = `${cdnBase}/avatars/${umsg.author.id}/${avatar}.${extension}?size=160`;
    } else {
      avatarURL = umsg.raw?.author?.avatarURL?.() ?? undefined;
    }
    return { username, avatarURL };
  }
  const username = withIndicator(umsg.author.globalName ?? umsg.author.username ?? "Fluxcord", "discord", nameIndicator);
  return { username, avatarURL: umsg.raw?.author?.avatarURL?.() ?? undefined };
}

async function renderContent(umsg, targetEndpoint, opts) {
  const { parsedSeed, canBridgePing, forwarded } = opts;
  const targetPlatform = targetEndpoint.platform;
  const targetClient = targetPlatform === "fluxer" ? resolveFluxerClient(targetEndpoint.instanceId) : opts.ctx?.discordClient;

  let targetGuild = null;
  try {
    targetGuild = await targetClient.guilds.fetch(targetEndpoint.guildId);
  } catch (e) {
    log("DEBUG", `renderContent: failed to fetch target guild ${targetEndpoint.guildId}`, e);
  }

  let content = await parseMentions(umsg.raw, parsedSeed ?? null, targetGuild, targetPlatform);
  content = sanitizePings(content, canBridgePing && !forwarded);

  if (targetGuild) {
    content = await resolveMentions(targetGuild, content);
  }

  if (umsg.platform === "fluxer" && targetPlatform === "discord") {
    content = await parseFluxerEmojiToDiscord(content, targetClient, targetEndpoint.guildId, umsg.instanceId);
  }
  if (umsg.platform === "fluxer" && targetPlatform === "fluxer" && targetEndpoint.instanceId !== umsg.instanceId) {
    content = await parseFluxerEmojiToFluxer(content, targetClient, umsg.instanceId);
  }
  if (umsg.platform === "discord" && targetPlatform === "fluxer") {
    const tempGuildId = getFluxerInstanceConfig(targetEndpoint.instanceId)?.FluxerTempEmojiGuildId;
    content = await parseDiscordEmojiToFluxer(content, targetClient, targetEndpoint.guildId, tempGuildId);
  }

  content = await traverseMessageLinks(content);

  if (umsg.platform === "discord") {
    content = await refreshDiscordCdnLinks(content, opts.ctx?.discordClient, umsg.id);
  }

  return content ?? "";
}

export async function renderForTarget(umsg, targetEndpoint, opts = {}) {
  const refMessageId = opts.refMessageId ?? null;
  const refMessage = opts.refMessage ?? null;
  const forwarded = Boolean(umsg.forwardedSnapshot) || Boolean(opts.forwarded);
  const bridgeContent = opts.bridgeContent ?? { messageData: { parsedContent: umsg.content } };
  const targetPlatform = targetEndpoint.platform;

  const nameIndicator = await resolveNameIndicator(targetEndpoint.guildId, umsg.guildId).catch(() => undefined);
  const { canUserPing, canUserEmbed } = await sourcePermissions(umsg, opts.ctx);
  const canBridgePing = canUserPing && (await everyonePingEnabled(targetEndpoint));

  const parsedContent = await renderContent(umsg, targetEndpoint, {
    parsedSeed: bridgeContent?.messageData?.parsedContent ?? null,
    canBridgePing,
    forwarded,
    ctx: opts.ctx,
  });

  const identity = await renderIdentity(umsg, nameIndicator);
  const headerPrefix = replyLineForPlatform(targetPlatform, targetEndpoint.instanceId);

  const parts = [];
  if (forwarded) parts.push(`${headerPrefix}${targetPlatform === "fluxer" ? "Forwarded" : "Forwarded message"}\n`);
  if (umsg.platform === "discord") {
    const interactingUser = umsg.raw?.interactionMetadata?.user;
    if (interactingUser) {
      parts.push(
        `${headerPrefix} ${indicatorPrefix("discord", nameIndicator)}@${interactingUser.tag} used \`/${umsg.raw?.interaction?.commandName}\`\n`
      );
    }
    if (umsg.raw?.flags?.has?.(MessageFlags.IsComponentsV2)) parts.push("*Components V2 message*");
  }

  let content = parsedContent;
  if (umsg.platform === "discord" && umsg.type === MessageType.ChannelFollowAdd) {
    content = `**${indicatorPrefix("discord", nameIndicator)}@${sourceAuthorTag(umsg)}** followed **${parsedContent}** into this channel. Messages published there will appear here.`;
  } else if (umsg.platform === "fluxer" && umsg.type === 12) {
    content = `**${indicatorPrefix("fluxer", nameIndicator)}@${sourceAuthorTag(umsg)}** has added **${parsedContent}** to this channel. Its most important updates will show up here.`;
  }
  parts.push(content);

  if (umsg.type === 7) {
    const joinedWhat = umsg.platform === "discord" ? "server" : "community";
    parts.push(`*${indicatorPrefix(umsg.platform, nameIndicator)}@${sourceAuthorTag(umsg)} joined the bridged ${joinedWhat}*`);
  }

  const maxAttachmentSize = targetPlatform === "discord" ? DISCORD_MAX_ATTACHMENT_SIZE : FLUXER_MAX_ATTACHMENT_SIZE;
  const overLimitLabel = targetPlatform === "discord" ? "over 25mb" : "over 20mb";

  const okAttachments = umsg.attachments.filter(a => a.size <= maxAttachmentSize);
  const overAttachments = umsg.attachments.filter(a => a.size > maxAttachmentSize);
  if (overAttachments.length > 0) {
    parts.push(
      `\n-# has attachments ${overLimitLabel}: ${overAttachments.map(a => `[${a.filename}](<${attachmentUrl(a)}>)`).join(" ")}`
    );
  }

  const files = [];
  const stickerFallbacks = [];
  const stickerLottie = [];
  for (const sticker of umsg.stickers ?? []) {
    let stickerUrl = sticker.url ?? null;
    let animated = sticker.format === 2 || sticker.animated === true;
    if (umsg.platform === "fluxer") {
      const mediaBase = (await getFluxerMediaBaseUrl(umsg.instanceId).catch(() => undefined)) ?? Config.FluxerCDNBaseURL;
      stickerUrl = `${String(mediaBase).replace(/\/$/, "")}/stickers/${sticker.id}.webp?size=320&animated=${sticker.animated}`;
      animated = sticker.animated === true;
    }
    if (!stickerUrl || stickerUrl.endsWith("json")) {
      if (stickerUrl) stickerLottie.push(sticker.name);
      continue;
    }
    const processed = await processSticker(stickerUrl, { animated, name: sticker.name });
    if (processed) {
      if (targetPlatform === "fluxer") {
        files.push({ name: processed.filename, data: processed.buffer });
      } else {
        files.push({ attachment: processed.buffer, name: processed.filename });
      }
    } else {
      stickerFallbacks.push(`[${sticker.name}](${stickerUrl})`);
    }
  }
  if (stickerLottie.length > 0) parts.push(`-# Message contains stickers: ${stickerLottie.join(", ")}`);
  if (stickerFallbacks.length > 0) parts.push(stickerFallbacks.join(", "));

  const targetClient = targetPlatform === "fluxer" ? resolveFluxerClient(targetEndpoint.instanceId) : opts.ctx?.discordClient;

  let embeds = [...(umsg.embeds ?? [])];
  if (typeof bridgeContent?.excludeEmbed === "number") embeds.splice(bridgeContent.excludeEmbed, 1);
  if (umsg.platform === "discord" && targetPlatform === "fluxer") {
    embeds = await Promise.all(
      embeds.filter(x => !isPlatformPreviewEmbed(x, umsg.content)).map(x => discordEmbedToFluxer(x, targetClient))
    );
  } else if (umsg.platform === "fluxer" && targetPlatform === "discord") {
    embeds = await fluxerEmbedToDiscord(umsg.raw, opts.ctx?.discordClient);
  }

  if (umsg.platform === "discord" && umsg.type === MessageType.PollResult && targetPlatform === "fluxer") {
    const fields = Object.fromEntries((umsg.embeds?.[0]?.fields ?? []).map(x => [x.name, x.value]));
    const totalVotes = Number(fields.total_votes) || 0;
    const victorVotes = Number(fields.victor_answer_votes) || 0;
    const pct = totalVotes > 0 ? Math.round((victorVotes / totalVotes) * 100) : 0;
    parts.length = 0;
    parts.push(`-# ${identity.username}'s poll has closed! The winner was ${fields.victor_answer_text} (${pct}%)`);
    embeds = [];
  }

  if (targetPlatform === "fluxer") {
    for (const a of okAttachments) {
      files.push({
        name: a.filename,
        url: a.url,
        flags: umsg.platform === "discord" && isDiscordSpoilerAttachment(a) ? SPOILER_ATTACHMENT_FLAG : undefined,
        description: a.description ?? undefined,
      });
    }
  }

  let replyHeader = "";
  let messageReferenceOption;
  if (refMessageId && !forwarded) {
    if (targetPlatform === "fluxer") {
      const localReply = await findReplyCopy(targetEndpoint.channelId, refMessageId);
      if (localReply?.messageId && localReply.endpoint?.platform === "fluxer") {
        messageReferenceOption = { message_id: localReply.messageId };
      } else {
        replyHeader = `${headerPrefix}Unbridged message\n`;
      }
    } else {
      replyHeader = await renderReplyLine(
        {
          channelId: targetEndpoint.channelId,
          guildId: targetEndpoint.guildId,
          platform: targetPlatform,
          instanceId: targetEndpoint.instanceId,
          nameIndicator,
        },
        refMessageId,
        refMessage
      );
    }
  }

  if (targetPlatform === "discord") {
    for (const a of okAttachments) {
      if (umsg.platform === "fluxer") {
        const data = await downloadFluxerAttachment(a.url);
        if (!data) continue;
        files.push({
          attachment: data,
          name: toDiscordSpoilerFilename(a.filename, a.spoiler),
          description: a.description ?? undefined,
        });
      } else {
        files.push({ attachment: a.proxyUrl ?? a.url, name: a.filename, description: a.description ?? undefined });
      }
    }
  }

  let attachmentUploads;
  if (targetPlatform === "discord" && umsg.platform === "fluxer" && files.length > 0) {
    attachmentUploads = await cloudUploadAttachments(opts.ctx?.discordClient, targetEndpoint.channelId, files).catch(
      () => undefined
    );
  }

  let payloadContent = replyHeader + parts.join("");
  if (!payloadContent.trim() && files.length === 0 && embeds.length === 0) {
    payloadContent =
      umsg.platform === "discord" && umsg.raw?.poll
        ? "-# Sent a poll"
        : umsg.platform === "discord" && umsg.stickers?.length
          ? "-# Sent an unsupported sticker or empty message"
          : "-# Sent an unsupported message";
  }

  const allowedMentions = {
    parse: forwarded ? [] : ["users", "roles", ...(canBridgePing ? ["everyone"] : [])],
    ...(targetPlatform === "fluxer" ? { replied_user: true } : { replied_user: false }),
  };

  const flags =
    targetPlatform === "discord"
      ? (umsg.flags.silent ? 4096 : 0) | (canUserEmbed ? 0 : 4)
      : (umsg.flags.silent ? 4096 : 0) |
        (umsg.platform === "discord" ? (canUserEmbed ? 0 : 4) : umsg.flags.suppressEmbeds || !canUserEmbed ? 4 : 0);

  return {
    content: payloadContent,
    files,
    embeds,
    username: identity.username,
    avatarURL: identity.avatarURL,
    flags,
    allowedMentions,
    messageReferenceOption,
    threadId: targetEndpoint.kind === "thread" ? targetEndpoint.channelId : null,
    attachmentUploads,
  };
}

export async function renderPlain(umsg, targetEndpoint) {
  const maxAttachmentSize = targetEndpoint.platform === "discord" ? DISCORD_MAX_ATTACHMENT_SIZE : FLUXER_MAX_ATTACHMENT_SIZE;
  const files = umsg.attachments
    .filter(a => a.size <= maxAttachmentSize)
    .map(a =>
      targetEndpoint.platform === "fluxer"
        ? { url: a.proxyUrl ?? a.url, name: a.filename }
        : { attachment: a.proxyUrl ?? a.url, name: a.filename }
    );
  return {
    content: umsg.content ?? "",
    files,
    embeds: umsg.embeds ?? [],
    username: umsg.author ? (umsg.author.globalName ?? umsg.author.username) : undefined,
    avatarURL: undefined,
    flags: 0,
    allowedMentions: { parse: [] },
    threadId: targetEndpoint.kind === "thread" ? targetEndpoint.channelId : null,
    attachmentUploads: undefined,
  };
}
