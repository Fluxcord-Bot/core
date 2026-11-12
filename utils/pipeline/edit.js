import { MessageLink } from "../../db/index.js";
import { findLinkSiblings } from "../Bridging.js";
import { canUserBridge } from "../UserOptOut.js";
import { checkEmbedPerms } from "../CheckManageServerPerms.js";
import { isBridgeToggleEnabled } from "../BridgeToggle.js";
import { getDiscordWebhook } from "../Webhooks.js";
import { sendFluxerWebhook, editFluxerWebhook } from "../FluxerWebhookSend.js";
import { withFluxerRateLimit, isFluxerRateLimitError } from "../FluxerRateLimit.js";
import { Routes as FluxerRoutes } from "@fluxerjs/core";
import { resolveFluxerClient } from "../FluxerClients.js";
import { renderForTarget, FLUXER_MAX_ATTACHMENT_SIZE, DISCORD_MAX_ATTACHMENT_SIZE } from "./render.js";
import { resolveDiscordReference, resolveFluxerReference } from "./references.js";
import { log } from "../Logger.js";

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

export async function handleEdit(umsg) {
  if (umsg.guildId == null || !umsg.author) return;
  if (umsg.platform === "discord" && umsg.type === 30) return;

  if (!(await canUserBridge(umsg.platform, umsg.author.id, umsg.guildId))) return;

  const relayWebhookId = umsg.platform === "fluxer" ? (umsg.webhookId ?? umsg.author.id ?? null) : (umsg.webhookId ?? null);
  if (relayWebhookId) {
    const { BridgeEndpoint } = await import("../../db/index.js");
    const echoRow = await BridgeEndpoint.findOne({
      where: { platform: umsg.platform, channelId: umsg.channelId, webhookId: relayWebhookId },
      raw: true,
    });
    if (echoRow) {
      log("DEBUG", `Edit skip ${umsg.platform} id=${umsg.id} reason=webhookEcho`);
      return;
    }
  }

  const linkRows = await MessageLink.findAll({ where: { messageId: umsg.id }, include: ["endpoint"] });
  const sourceRows = linkRows.filter(
    row => row.endpoint?.platform === umsg.platform && row.endpoint?.channelId === umsg.channelId
  );
  if (sourceRows.length === 0) {
    log("DEBUG", `Edit skip ${umsg.platform} id=${umsg.id} reason=unbridgedMessage`);
    return;
  }

  const canUserEmbed = umsg.webhookId ? true : await checkEmbedPerms(umsg.guildId, umsg.channelId, umsg.author.id, umsg.client);

  const refMessageId = !umsg.flags.crosspost && umsg.reference?.type !== 1 ? (umsg.reference?.messageId ?? null) : null;
  let refMessageForUpdate = null;
  if (refMessageId) {
    refMessageForUpdate =
      umsg.platform === "fluxer"
        ? await resolveFluxerReference(umsg.raw, umsg.client)
        : await resolveDiscordReference(umsg.raw, umsg.client);
  }

  await Promise.allSettled(
    sourceRows.flatMap(async sourceRow => {
      const siblings = await findLinkSiblings(sourceRow.linkGroup);

      return siblings
        .filter(s => s.endpoint?.id !== sourceRow.endpointId)
        .map(async other => {
          const targetEndpoint = other.endpoint;
          if (!targetEndpoint) return;

          const render = await renderForTarget(umsg, targetEndpoint, {
            refMessageId,
            refMessage: refMessageForUpdate,
            ctx: umsg.ctx,
          });

          try {
            if (targetEndpoint.platform === "fluxer") {
              const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);
              const current = await withFluxerRateLimit(
                () => fluxerClient.rest.get(FluxerRoutes.channelMessage(targetEndpoint.channelId, other.messageId)),
                `channel:${targetEndpoint.channelId}`
              );
              const currentFlags = current?.flags ?? 0;
              const nextFlags = (render.flags & 4 ? currentFlags | 4 : currentFlags & ~4) | (render.flags & 4096 ? 4096 : 0);

              if (!render.content && render.embeds.length === 0 && !(render.flags & 4) && render.files.length === 0) {
                log("DEBUG", `Edit skip ${umsg.platform} id=${umsg.id} reason=emptyEdit`);
                return;
              }

              if (targetEndpoint.webhookId) {
                await editFluxerWebhook(targetEndpoint.webhookId, targetEndpoint.webhookToken, fluxerClient, other.messageId, {
                  content: render.content,
                  embeds: render.embeds,
                  flags: nextFlags,
                });
              } else {
                await withFluxerRateLimit(
                  () =>
                    fluxerClient.rest.patch(FluxerRoutes.channelMessage(targetEndpoint.channelId, other.messageId), {
                      body: {
                        content: render.content,
                        embeds: render.embeds,
                        flags: nextFlags,
                      },
                    }),
                  `channel:${targetEndpoint.channelId}`
                );
              }
            } else {
              const webhook = await getDiscordWebhook(umsg.ctx.discordClient, targetEndpoint);
              if (!webhook) return;
              await webhook.editMessage(other.messageId, {
                content: render.content,
                embeds: render.embeds,
                attachments: render.attachmentUploads,
                ...(targetEndpoint.kind === "thread" ? { threadId: targetEndpoint.channelId } : {}),
                flags: render.flags,
                allowedMentions: { parse: [] },
              });
            }
          } catch (e) {
            if (!isDiscordUnknownMessageError(e) && !isFluxerUnknownMessageError(e) && !isFluxerRateLimitError(e)) {
              log("BRIDGE", `Failed to edit copy of message ${umsg.id} on ${targetEndpoint.platform}`, e);
            }
          }
        });
    })
  );
}

export { FLUXER_MAX_ATTACHMENT_SIZE, DISCORD_MAX_ATTACHMENT_SIZE };
