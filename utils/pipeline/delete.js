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
    const siblings = await MessageLink.findAll({ where: { linkGroup }, include: ["endpoint"] });
    const sourceRowIds = new Set(sourceRows.map(row => row.id));
    const byTarget = new Map();
    for (const row of siblings) {
      if (!row.endpoint || sourceRowIds.has(row.id) || !row.messageId) continue;
      const key = `${row.endpoint.platform}:${row.endpoint.channelId}`;
      if (!byTarget.has(key)) byTarget.set(key, { endpoint: row.endpoint, ids: [] });
      byTarget.get(key).ids.push(row.messageId);
    }
    for (const { endpoint, ids } of byTarget.values()) {
      try {
        const channel =
          endpoint.platform === "discord"
            ? await ctx.discordClient.channels.fetch(endpoint.channelId).catch(() => null)
            : await resolveFluxerClient(endpoint.instanceId)
                .channels.fetch(endpoint.channelId)
                .catch(() => null);
        if (!channel?.isSendable?.()) continue;
        const notice = await channel.send({ content: "Bridging bulk deletes, please wait..." });
        try {
          await channel.bulkDelete(ids);
        } catch {}
        await notice.delete().catch(() => {});
      } catch (e) {
        log("BRIDGE", `Bulk delete mirror failed on ${endpoint.platform} channel ${endpoint.channelId}`, e);
      }
    }
    await deleteLogicalMessage(linkGroup, ctx.discordClient);
    await rewriteRepliesForDeleted(linkGroup, ctx.discordClient);
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
