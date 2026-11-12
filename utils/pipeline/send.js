import { MessageLink } from "../../db/index.js";
import { Op } from "sequelize";
import { sendFluxerWebhook } from "../FluxerWebhookSend.js";
import { getDiscordWebhook } from "../Webhooks.js";
import { resolveDiscordThreadChannel } from "../DiscordThreadResolver.js";
import { maybePublishDiscordMessage, maybePublishFluxerMessage } from "../AnnouncementPublish.js";
import { resolveFluxerClient } from "../FluxerClients.js";
import { recordRelay } from "../Bridging.js";
import { log } from "../Logger.js";

export async function sendToTarget(umsg, targetEndpoint, render, ctx, relayMeta) {
  const sent =
    targetEndpoint.platform === "discord"
      ? await sendToDiscordEndpoint(umsg, targetEndpoint, render, ctx, relayMeta)
      : await sendToFluxerEndpoint(umsg, targetEndpoint, render, relayMeta);
  if (sent?.id && relayMeta.endpoints?.length) {
    try {
      await MessageLink.update(
        { messageId: sent.id },
        { where: { linkGroup: relayMeta.linkGroup, endpointId: { [Op.in]: relayMeta.endpoints.map(e => e.id) } } }
      );
    } catch (e) {
      log("DB", `Failed to backfill copy id for endpoint ${targetEndpoint.id}`, e);
    }
  }
  return sent;
}

async function sendToDiscordEndpoint(umsg, targetEndpoint, render, ctx, relayMeta) {
  if (!targetEndpoint.webhookId) {
    log("DEBUG", `Pipeline skip target endpoint=${targetEndpoint.id} reason=noDiscordWebhook`);
    return null;
  }

  const webhook = await getDiscordWebhook(ctx.discordClient, targetEndpoint);
  if (!webhook) return null;

  let threadId = null;
  if (targetEndpoint.kind === "thread") {
    threadId = targetEndpoint.channelId;
  } else {
    const discordThread = await resolveDiscordThreadChannel(ctx.discordClient, targetEndpoint.channelId).catch(() => null);
    if (discordThread?.archived && !discordThread.locked) {
      try {
        await discordThread.setArchived(false);
      } catch (e) {
        log("DISCORD", `Failed to unarchive bridged Discord thread ${discordThread.id}`, e);
      }
    }
    threadId = discordThread?.id ?? null;
  }

  const files = render.attachmentUploads?.length
    ? render.files.map(f => ({ ...f, attachment: f.attachment instanceof Buffer ? f.attachment : f.attachment }))
    : render.files;

  let sent;
  try {
    sent = await webhook.send({
      content: render.content,
      embeds: render.embeds,
      username: render.username,
      avatarURL: render.avatarURL,
      files,
      allowedMentions: render.allowedMentions,
      flags: render.flags,
      ...(threadId ? { threadId } : {}),
      ...(render.attachmentUploads ? { attachments: render.attachmentUploads } : {}),
    });
  } catch (e) {
    log("DISCORD", `Failed to bridge ${umsg.platform} message ${umsg.id} into Discord channel ${targetEndpoint.channelId}`, e);
    return null;
  }

  recordRelay(targetEndpoint.id, targetEndpoint.webhookId, relayMeta.linkGroup, relayMeta.sourceGroupId ?? null);

  try {
    await maybePublishDiscordMessage(ctx.discordClient, targetEndpoint, sent.id);
  } catch {}

  log("DEBUG", `Pipeline bridged ${umsg.platform}Id=${umsg.id} discordId=${sent.id} endpoint=${targetEndpoint.id}`);
  return sent;
}

async function sendToFluxerEndpoint(umsg, targetEndpoint, render, relayMeta) {
  if (!targetEndpoint.webhookId) {
    log("DEBUG", `Pipeline skip target endpoint=${targetEndpoint.id} reason=noFluxerWebhook`);
    return null;
  }

  const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);

  let sent;
  try {
    sent = await sendFluxerWebhook(targetEndpoint.webhookId, targetEndpoint.webhookToken, fluxerClient, {
      content: render.content,
      username: render.username,
      avatar_url: render.avatarURL,
      embeds: render.embeds,
      files: render.files,
      message_reference: render.messageReferenceOption,
      allowed_mentions: render.allowedMentions,
      flags: render.flags,
      ...(targetEndpoint.kind === "thread" ? { threadId: targetEndpoint.channelId } : {}),
    });
  } catch (e) {
    if (render.messageReferenceOption && (e?.code === "UNKNOWN_MESSAGE" || e?.code === "MESSAGE_NOT_FOUND")) {
      log("DEBUG", `Pipeline retry without message_reference ${umsg.platform} message ${umsg.id} endpoint=${targetEndpoint.id}`);
      try {
        sent = await sendFluxerWebhook(targetEndpoint.webhookId, targetEndpoint.webhookToken, fluxerClient, {
          content: render.content,
          username: render.username,
          avatar_url: render.avatarURL,
          embeds: render.embeds,
          files: render.files,
          allowed_mentions: render.allowedMentions,
          flags: render.flags,
          ...(targetEndpoint.kind === "thread" ? { threadId: targetEndpoint.channelId } : {}),
        });
      } catch (e2) {
        log("FLUXER", `Failed to bridge ${umsg.platform} message ${umsg.id} into Fluxer channel ${targetEndpoint.channelId}`, e2);
        return null;
      }
    } else {
      log("FLUXER", `Failed to bridge ${umsg.platform} message ${umsg.id} into Fluxer channel ${targetEndpoint.channelId}`, e);
      return null;
    }
  }

  recordRelay(targetEndpoint.id, targetEndpoint.webhookId, relayMeta.linkGroup, relayMeta.sourceGroupId ?? null);

  try {
    await maybePublishFluxerMessage(fluxerClient, targetEndpoint, sent?.id);
  } catch {}

  log(
    "DEBUG",
    `Pipeline bridged ${umsg.platform}Id=${umsg.id} fluxerId=${sent?.id} instance=${targetEndpoint.instanceId} endpoint=${targetEndpoint.id}`
  );
  return sent;
}
