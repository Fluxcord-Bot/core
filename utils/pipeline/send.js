import { MessageLink } from "../../db/index.js";
import { Op } from "sequelize";
import { sendFluxerWebhook } from "../FluxerWebhookSend.js";
import { getDiscordWebhook, hasFluxerWebhook, invalidateFluxerWebhookCache } from "../Webhooks.js";
import { createWebhookFor } from "../SetupHelper.js";
import { BridgeEndpoint } from "../../db/index.js";
import { resolveDiscordThreadChannel } from "../DiscordThreadResolver.js";
import { maybePublishDiscordMessage, maybePublishFluxerMessage } from "../AnnouncementPublish.js";
import { resolveFluxerClient } from "../FluxerClients.js";
import { withFluxerRateLimit } from "../FluxerRateLimit.js";
import { recordRelay } from "../Bridging.js";
import { log } from "../Logger.js";

export async function sendToTarget(umsg, targetEndpoint, render, ctx, relayMeta) {
  if (targetEndpoint.webhookId) {
    recordRelay(targetEndpoint.id, targetEndpoint.webhookId, relayMeta.linkGroup, relayMeta.sourceGroupId ?? null);
  }
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
    try {
      const rows = await MessageLink.findAll({ where: { linkGroup: relayMeta.linkGroup }, raw: true });
      log(
        "DEBUG",
        `LinkState group=${relayMeta.linkGroup} afterSend endpoint=${targetEndpoint.id} sentId=${sent.id} rows=[${rows
          .map(r => `${r.endpointId}:${r.messageId}`)
          .join(", ")}]`
      );
    } catch {}
  }
  return sent;
}

export async function sendEarlyBridge(umsg, targetEndpoint, earlyRender, ctx) {
  try {
    if (targetEndpoint.platform === "discord") {
      if (!targetEndpoint.webhookId) return null;
      const webhook = await getDiscordWebhook(ctx.discordClient, targetEndpoint);
      if (!webhook) return null;
      let threadId = null;
      if (targetEndpoint.kind === "thread") threadId = targetEndpoint.channelId;
      else
        threadId = (await resolveDiscordThreadChannel(ctx.discordClient, targetEndpoint.channelId).catch(() => null))?.id ?? null;
      const msg = await webhook.send({
        content: earlyRender.content,
        username: earlyRender.username,
        avatarURL: earlyRender.avatarURL,
        allowedMentions: earlyRender.allowedMentions,
        flags: earlyRender.flags,
        ...(threadId ? { threadId } : {}),
      });
      log("DEBUG", `Pipeline early bridge id=${umsg.id} discordId=${msg.id} endpoint=${targetEndpoint.id}`);
      return msg;
    }
    if (!targetEndpoint.webhookId) return null;
    const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);
    const msg = await sendFluxerWebhook(targetEndpoint.webhookId, targetEndpoint.webhookToken, fluxerClient, {
      content: earlyRender.content,
      username: earlyRender.username,
      avatar_url: earlyRender.avatarURL,
      files: [],
      message_reference: earlyRender.messageReferenceOption,
      allowed_mentions: earlyRender.allowedMentions,
      flags: earlyRender.flags,
      channelId: targetEndpoint.channelId,
      ...(targetEndpoint.kind === "thread" ? { threadId: targetEndpoint.channelId } : {}),
    });
    log("DEBUG", `Pipeline early bridge id=${umsg.id} fluxerId=${msg?.id} endpoint=${targetEndpoint.id}`);
    return msg;
  } catch (e) {
    log("DEBUG", `Early bridge placeholder failed for ${umsg.id} endpoint=${targetEndpoint.id}`, e);
    return null;
  }
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

  const cloudFiles = render.attachmentUploads?.length ? render.attachmentUploads : null;

  let sent;
  try {
    if (render.editMessageId) {
      try {
        sent = await webhook.editMessage(render.editMessageId, {
          content: render.content,
          embeds: render.embeds,
          files: cloudFiles ? [] : render.files,
          flags: render.flags,
          ...(cloudFiles ? { attachments: cloudFiles } : {}),
          ...(threadId ? { threadId } : {}),
        });
      } catch (e) {
        log("DISCORD", `Failed to edit early bridged Discord message ${render.editMessageId}`, e);
        try {
          await webhook.deleteMessage(render.editMessageId, threadId ?? undefined);
        } catch {}
        sent = await webhook.send({
          content: render.content,
          embeds: render.embeds,
          username: render.username,
          avatarURL: render.avatarURL,
          files: cloudFiles ? [] : render.files,
          allowedMentions: render.allowedMentions,
          flags: render.flags,
          ...(threadId ? { threadId } : {}),
          ...(cloudFiles ? { attachments: cloudFiles } : {}),
        });
      }
    } else {
      sent = await webhook.send({
        content: render.content,
        embeds: render.embeds,
        username: render.username,
        avatarURL: render.avatarURL,
        files: cloudFiles ? [] : render.files,
        allowedMentions: render.allowedMentions,
        flags: render.flags,
        ...(threadId ? { threadId } : {}),
        ...(cloudFiles ? { attachments: cloudFiles } : {}),
      });
    }
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

async function ensureFluxerWebhook(targetEndpoint, fluxerClient) {
  try {
    const parent =
      targetEndpoint.kind === "thread" && targetEndpoint.parentEndpointId
        ? await BridgeEndpoint.findByPk(targetEndpoint.parentEndpointId)
        : null;
    const webhookChannelId = parent?.channelId ?? targetEndpoint.channelId;
    const channel = await fluxerClient.channels.fetch(webhookChannelId);
    const webhook = await createWebhookFor(
      channel,
      "fluxer",
      `Fluxcord Bridge (${webhookChannelId} F ${targetEndpoint.guildId})`
    );
    if (!webhook) return false;
    targetEndpoint.webhookId = webhook.id;
    targetEndpoint.webhookToken = webhook.token;
    await BridgeEndpoint.update(
      { webhookId: webhook.id, webhookToken: webhook.token },
      { where: { id: targetEndpoint.id } }
    );
    if (parent) {
      parent.webhookId = webhook.id;
      parent.webhookToken = webhook.token;
      await BridgeEndpoint.update(
        { webhookId: webhook.id, webhookToken: webhook.token },
        { where: { id: parent.id } }
      );
    }
    log("DEBUG", `Pipeline lazily created fluxer webhook endpoint=${targetEndpoint.id} webhook=${webhook.id}`);
    return true;
  } catch (e) {
    log("FLUXER", `Failed to lazily create webhook for endpoint ${targetEndpoint.id}`, e);
    return false;
  }
}

async function sendToFluxerEndpoint(umsg, targetEndpoint, render, relayMeta) {
  const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);

  if (!targetEndpoint.webhookId) {
    const made = await ensureFluxerWebhook(targetEndpoint, fluxerClient);
    if (!made) {
      log("DEBUG", `Pipeline skip target endpoint=${targetEndpoint.id} reason=noFluxerWebhook`);
      return null;
    }
  }

  if (!render.editMessageId) {
    const webhookExists = await hasFluxerWebhook(fluxerClient, targetEndpoint.channelId, targetEndpoint.webhookId);
    if (!webhookExists) {
      invalidateFluxerWebhookCache(targetEndpoint.channelId);
      const made = await ensureFluxerWebhook(targetEndpoint, fluxerClient);
      if (!made) {
        log("DEBUG", `Pipeline skip target endpoint=${targetEndpoint.id} reason=missingFluxerWebhook`);
        try {
          await MessageLink.destroy({ where: { linkGroup: relayMeta.linkGroup, endpointId: targetEndpoint.id } });
        } catch (e) {
          log("DB", `Failed to clean link rows for missing webhook endpoint ${targetEndpoint.id}`, e);
        }
        return null;
      }
    }
  }

  let sent;
  try {
    if (render.editMessageId) {
      const threadSuffix = targetEndpoint.kind === "thread" ? `?thread_id=${targetEndpoint.channelId}` : "";
      try {
        await withFluxerRateLimit(
          () =>
            fluxerClient.rest.patch(
              `/webhooks/${targetEndpoint.webhookId}/${targetEndpoint.webhookToken}/messages/${render.editMessageId}${threadSuffix}`,
              {
                body: {
                  content: render.content,
                  embeds: render.embeds,
                  allowed_mentions: render.allowedMentions,
                  flags: render.flags,
                },
                auth: false,
              }
            ),
          `webhook-patch:${targetEndpoint.webhookId}`
        );
      } catch (e) {
        log("FLUXER", `Failed to edit early bridged Fluxer message ${render.editMessageId}`, e);
      }
      sent = { id: render.editMessageId };
    } else {
      sent = await sendFluxerWebhook(targetEndpoint.webhookId, targetEndpoint.webhookToken, fluxerClient, {
        content: render.content,
        username: render.username,
        avatar_url: render.avatarURL,
        embeds: render.embeds,
        files: render.files,
        message_reference: render.messageReferenceOption,
        allowed_mentions: render.allowedMentions,
        flags: render.flags,
        channelId: targetEndpoint.channelId,
        ...(targetEndpoint.kind === "thread" ? { threadId: targetEndpoint.channelId } : {}),
      });
    }
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
          channelId: targetEndpoint.channelId,
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
