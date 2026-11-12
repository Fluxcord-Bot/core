import { MessageLink } from "../db/index.js";
import { isDeletedGroup, markDeletedGroup } from "./Bridging.js";
import { getDiscordWebhook } from "./Webhooks.js";
import { resolveFluxerClient } from "./FluxerClients.js";
import { Routes as FluxerRoutes } from "@fluxerjs/core";
import { withFluxerRateLimit } from "./FluxerRateLimit.js";
import { log } from "./Logger.js";

const replyHeaderRegex = /-# <:reply_l:[^>]+><:reply_r:[^>]+>.*?\(<https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+>\)\n?/;

function isDiscordUnknownMessageError(error) {
  return error?.code === 10008 || (error?.status === 404 && /unknown message/i.test(error?.message ?? ""));
}

function isFluxerUnknownMessageError(error) {
  return (
    error?.code === "MESSAGE_NOT_FOUND" ||
    error?.code === "UNKNOWN_MESSAGE" ||
    error?.status === 404 ||
    error?.statusCode === 404 ||
    error?.cause?.statusCode === 404
  );
}

async function deleteFluxerCopy(endpoint, messageId) {
  const fluxerClient = resolveFluxerClient(endpoint.instanceId);
  await withFluxerRateLimit(
    () => fluxerClient.rest.delete(FluxerRoutes.channelMessage(endpoint.channelId, messageId)),
    `channel:${endpoint.channelId}`
  );
}

async function deleteDiscordCopy(discordClient, endpoint, messageId) {
  if (endpoint.webhookId) {
    const webhook = getDiscordWebhook(discordClient, endpoint);
    await webhook.deleteMessage(messageId, endpoint.kind === "thread" ? endpoint.channelId : undefined);
    return;
  }
  const channel = await discordClient.channels.fetch(endpoint.channelId);
  await channel.messages.delete(messageId);
}

/**
 * @param {string} linkGroup
 * @param {import("discord.js").Client} [discordClient]
 * @param {string[]} [onlyMessageIds]
 * @returns {Promise<void>}
 */
export async function deleteLogicalMessage(linkGroup, discordClient, onlyPlatformIds) {
  if (!linkGroup) return;
  if (isDeletedGroup(linkGroup)) {
    await MessageLink.destroy({ where: { linkGroup } });
    return;
  }
  markDeletedGroup(linkGroup);

  const rows = await MessageLink.findAll({ where: { linkGroup }, include: ["endpoint"] });
  await MessageLink.destroy({ where: { linkGroup } });

  for (const row of rows) {
    if (onlyPlatformIds && !onlyPlatformIds.includes(row.messageId)) continue;
    try {
      if (row.endpoint?.platform === "discord") {
        await deleteDiscordCopy(discordClient, row.endpoint, row.messageId);
      } else if (row.endpoint?.platform === "fluxer") {
        await deleteFluxerCopy(row.endpoint, row.messageId);
      }
    } catch (e) {
      if (!isDiscordUnknownMessageError(e) && !isFluxerUnknownMessageError(e)) {
        log("BRIDGE", `Failed to delete copy of logical message ${linkGroup} on ${row.endpoint?.platform}`, e);
      }
    }
  }
}

/**
 * @param {string} linkGroup
 * @param {import("discord.js").Client} discordClient
 * @returns {Promise<void>}
 */
export async function rewriteRepliesForDeleted(linkGroup, discordClient) {
  const rows = await MessageLink.findAll({ where: { linkGroup }, include: ["endpoint"] });
  if (rows.length === 0) return;

  const referencing = await MessageLink.findAll({
    where: { replyId: rows.map(r => r.messageId) },
    include: ["endpoint"],
  });

  for (const ref of referencing) {
    if (ref.endpoint?.platform !== "discord") continue;
    try {
      if (!ref.endpoint?.webhookId) continue;
      const webhook = await getDiscordWebhook(discordClient, ref.endpoint);
      const message = await webhook.fetchMessage(ref.messageId);
      if (!message?.content || !replyHeaderRegex.test(message.content)) continue;
      await webhook.editMessage(ref.messageId, {
        content: message.content.replace(replyHeaderRegex, ""),
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      if (!isDiscordUnknownMessageError(e)) {
        log("BRIDGE", `Failed to rewrite reply header for message ${ref.messageId}`, e);
      }
    }
  }
}
