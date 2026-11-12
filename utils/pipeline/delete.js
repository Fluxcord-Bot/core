import { MessageLink, BridgeEndpoint, BridgeGroup } from "../../db/index.js";
import { Op } from "sequelize";
import { deleteLogicalMessage, rewriteRepliesForDeleted } from "../LogicalMessage.js";
import { resolveFluxerClient } from "../FluxerClients.js";
import { invalidateFluxerWebhookCache } from "../Webhooks.js";
import { log } from "../Logger.js";

export async function handleDelete(umsg) {
  const rows = await MessageLink.findAll({ where: { messageId: umsg.id }, include: ["endpoint"] });

  const sourceRows = rows.filter(row => row.endpoint?.platform === umsg.platform && row.endpoint?.channelId === umsg.channelId);
  if (sourceRows.length === 0) {
    log("DEBUG", `Delete skip ${umsg.platform} id=${umsg.id} reason=unbridgedMessage`);
    return;
  }

  const linkGroups = [...new Set(sourceRows.map(row => row.linkGroup))];
  for (const linkGroup of linkGroups) {
    await deleteLogicalMessage(linkGroup, umsg.ctx.discordClient);
    await rewriteRepliesForDeleted(linkGroup, umsg.ctx.discordClient);
  }
}

export async function handleBulkDelete(platform, channelId, messageIds, ctx) {
  log("DEBUG", `BulkDelete received platform=${platform} channelId=${channelId} count=${messageIds?.length ?? 0}`);
  if (!messageIds?.length) return;

  const rows = await MessageLink.findAll({
    where: { messageId: messageIds },
    include: ["endpoint"],
  });

  const sourceRows = rows.filter(row => row.endpoint?.platform === platform && row.endpoint?.channelId === channelId);
  if (sourceRows.length === 0) {
    log("DEBUG", `BulkDelete skip platform=${platform} channelId=${channelId} reason=unbridgedMessage`);
    return;
  }

  const linkGroups = [...new Set(sourceRows.map(row => row.linkGroup))];
  for (const linkGroup of linkGroups) {
    await deleteLogicalMessage(linkGroup, ctx.discordClient);
  }
}

export async function destroyEndpoints(ref, ctx) {
  const where = { platform: ref.platform, channelId: ref.channelId };
  if (ref.instanceId) where.instanceId = ref.instanceId;
  const endpoints = await BridgeEndpoint.findAll({ where });
  if (endpoints.length === 0) return 0;

  const endpointIds = endpoints.map(e => e.id);
  const groupIds = [...new Set(endpoints.map(e => e.groupId))];

  await MessageLink.destroy({ where: { endpointId: { [Op.in]: endpointIds } } });

  for (const endpoint of endpoints) {
    if (endpoint.autoMirrored) continue;
    try {
      if (endpoint.platform === "discord" && endpoint.webhookId) {
        await ctx.discordClient.deleteWebhook(endpoint.webhookId, { token: endpoint.webhookToken ?? undefined });
      } else if (endpoint.platform === "fluxer" && endpoint.webhookId) {
        const fluxerClient = resolveFluxerClient(endpoint.instanceId);
        const channel = await fluxerClient.channels.fetch(endpoint.channelId);
        const webhooks = await channel?.fetchWebhooks();
        const webhook = webhooks?.find?.(x => x.id === endpoint.webhookId);
        await webhook?.delete();
        invalidateFluxerWebhookCache(endpoint.channelId);
      }
    } catch {}
  }

  await BridgeEndpoint.destroy({ where: { id: { $in: endpointIds } } });

  const remaining = await BridgeEndpoint.count({ where: { groupId: { [Op.in]: groupIds } } });
  if (remaining === 0) {
    await BridgeGroup.destroy({ where: { id: { [Op.in]: groupIds } } });
  }

  return endpoints.length;
}
