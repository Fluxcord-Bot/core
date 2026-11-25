import { Op } from "sequelize";
import { Routes as FluxerRoutes } from "@fluxerjs/core";
import { MessageLink } from "../../db/index.js";
import { findEndpoints } from "../Bridging.js";
import { resolveFluxerClient } from "../FluxerClients.js";
import { withFluxerRateLimit } from "../FluxerRateLimit.js";
import { log } from "../Logger.js";
import { collectTargets, linkedThreadFamilyEndpoints } from "./targets.js";

const PIN_PAGE_LIMIT = 100;

async function fetchAllDiscordPins(channel) {
  const ids = [];
  let before;
  for (let page = 0; page < PIN_PAGE_LIMIT; page++) {
    const result = await channel.messages.fetchPins(before ? { before } : {});
    ids.push(...result.items.map(x => x.message.id));
    if (!result.hasMore || result.items.length === 0) break;
    before = result.items[result.items.length - 1].pinnedAt;
    if (!before) break;
  }
  return ids;
}

async function fetchAllFluxerPins(channel) {
  const ids = [];
  let before;
  for (let page = 0; page < PIN_PAGE_LIMIT; page++) {
    const result = await channel.fetchPinnedMessagesPage(before ? { before } : {});
    ids.push(...result.messages.map(x => x.id));
    if (!result.hasMore || result.messages.length === 0) break;
    before = result.pinnedAt[result.pinnedAt.length - 1];
    if (!before) break;
  }
  return ids;
}

async function filterThreadTargets(targets, threadId) {
  const family = await linkedThreadFamilyEndpoints(threadId);
  if (family.size === 0) return targets;
  return targets
    .map(entry => ({ ...entry, endpoints: entry.endpoints.filter(e => family.has(e.id)) }))
    .filter(entry => entry.endpoints.length > 0);
}

export async function handlePins(platform, payload, options = {}) {
  if (platform === "discord") return handleDiscordPins(payload, options);
  return handleFluxerPins(payload, options);
}

async function handleDiscordPins(channel, options) {
  log("DEBUG", `DiscordPinsUpdate received channelId=${channel.id}`);

  const endpoints = await findEndpoints("discord", channel.id);
  if (endpoints.length === 0) return;
  const sourceKind = endpoints[0]?.kind ?? "channel";
  const sourceEndpoints = endpoints;
  const sourceEndpointIds = sourceEndpoints.map(e => e.id);

  const pinnedIds = await fetchAllDiscordPins(channel);

  const pinnedRows = await MessageLink.findAll({
    where: { messageId: { [Op.in]: pinnedIds }, endpointId: { [Op.in]: sourceEndpointIds } },
  });
  const ownPinnedGroups = new Set(pinnedRows.map(r => r.linkGroup));

  const sourceTargets = await collectTargets(sourceEndpoints, "discord", {
    kind: sourceKind,
    excludeChannelId: channel.id,
  });
  const targets = sourceKind === "thread" ? await filterThreadTargets(sourceTargets, channel.id) : sourceTargets;

  for (const entry of targets) {
    if (entry.endpoints[0].platform !== "fluxer") continue;
    const targetEndpoint = entry.endpoints[0];
    const targetEndpointIds = entry.endpoints.map(e => e.id);
    const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);

    const fluxerChannel = await fluxerClient.channels.fetch(targetEndpoint.channelId).catch(() => null);
    if (!fluxerChannel?.isTextBased?.()) continue;

    const fluxerPinnedIds = await withFluxerRateLimit(
      () => fetchAllFluxerPins(fluxerChannel),
      `channel:${targetEndpoint.channelId}`
    );

    if (ownPinnedGroups.size > 0) {
      const localRows = await MessageLink.findAll({
        where: { linkGroup: [...ownPinnedGroups], endpointId: { [Op.in]: targetEndpointIds } },
      });

      for (const local of localRows) {
        if (!fluxerPinnedIds.includes(local.messageId)) {
          try {
            await withFluxerRateLimit(
              () => fluxerClient.rest.put(FluxerRoutes.channelPinMessage(targetEndpoint.channelId, local.messageId)),
              `channel:${targetEndpoint.channelId}`
            );
          } catch (e) {
            log("DEBUG", `Failed to pin Fluxer message ${local.messageId} in ${targetEndpoint.channelId}`, e);
          }
        }
      }
    }

    if (fluxerPinnedIds.length > 0) {
      const targetPinnedRows = await MessageLink.findAll({
        where: { messageId: { [Op.in]: fluxerPinnedIds }, endpointId: { [Op.in]: targetEndpointIds } },
      });
      for (const targetRow of targetPinnedRows) {
        const sourceCopy = await MessageLink.findOne({
          where: { linkGroup: targetRow.linkGroup, endpointId: { [Op.in]: sourceEndpointIds } },
        });
        if (sourceCopy && !pinnedIds.includes(sourceCopy.messageId)) {
          try {
            await withFluxerRateLimit(
              () =>
                fluxerClient.rest.delete(
                  FluxerRoutes.channelPinMessage(targetEndpoint.channelId, targetRow.messageId)
                ),
              `channel:${targetEndpoint.channelId}`
            );
          } catch (e) {
            log("DEBUG", `Failed to unpin Fluxer message ${targetRow.messageId} in ${targetEndpoint.channelId}`, e);
          }
        }
      }
    }
  }
}

async function handleFluxerPins(payload, options) {
  const instanceId = options.instanceId ?? "default";
  const discordClient = options.discordClient;
  log("DEBUG", `FluxerPinsUpdate received channelId=${payload.channelId} instance=${instanceId}`);

  const endpoints = (await findEndpoints("fluxer", payload.channelId)).filter(
    e => (e.instanceId ?? "default") === instanceId
  );
  if (endpoints.length === 0) return;
  const sourceKind = endpoints[0]?.kind ?? "channel";
  const sourceEndpoints = endpoints;
  const sourceEndpointIds = sourceEndpoints.map(e => e.id);

  const fluxerClient = resolveFluxerClient(instanceId);
  const channel = await fluxerClient.channels.fetch(payload.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const pinnedIds = await withFluxerRateLimit(
    () => fetchAllFluxerPins(channel),
    `channel:${payload.channelId}`
  );

  const pinnedRows = await MessageLink.findAll({
    where: { messageId: { [Op.in]: pinnedIds }, endpointId: { [Op.in]: sourceEndpointIds } },
  });
  const ownPinnedGroups = new Set(pinnedRows.map(r => r.linkGroup));

  const sourceTargets = await collectTargets(sourceEndpoints, "fluxer", {
    kind: sourceKind,
    excludeChannelId: payload.channelId,
  });
  const targets =
    sourceKind === "thread" ? await filterThreadTargets(sourceTargets, payload.channelId) : sourceTargets;

  for (const entry of targets) {
    if (entry.endpoints[0].platform !== "discord") continue;
    const targetEndpoint = entry.endpoints[0];
    const targetEndpointIds = entry.endpoints.map(e => e.id);

    const discordChannel = await discordClient.channels.fetch(targetEndpoint.channelId).catch(() => null);
    if (!discordChannel?.isTextBased?.()) continue;

    const discordPinnedIds = await fetchAllDiscordPins(discordChannel);

    if (ownPinnedGroups.size > 0) {
      const localRows = await MessageLink.findAll({
        where: { linkGroup: [...ownPinnedGroups], endpointId: { [Op.in]: targetEndpointIds } },
      });

      for (const local of localRows) {
        if (!discordPinnedIds.includes(local.messageId)) {
          try {
            await discordChannel.messages.pin(local.messageId).catch(e => {
              if (e?.code !== 10003 && e?.code !== 10008) throw e;
            });
          } catch (e) {
            log("DEBUG", `Failed to pin Discord message ${local.messageId} in ${targetEndpoint.channelId}`, e);
          }
        }
      }
    }

    if (discordPinnedIds.length > 0) {
      const targetPinnedRows = await MessageLink.findAll({
        where: { messageId: { [Op.in]: discordPinnedIds }, endpointId: { [Op.in]: targetEndpointIds } },
      });
      for (const targetRow of targetPinnedRows) {
        const sourceCopy = await MessageLink.findOne({
          where: { linkGroup: targetRow.linkGroup, endpointId: { [Op.in]: sourceEndpointIds } },
        });
        if (sourceCopy && !pinnedIds.includes(sourceCopy.messageId)) {
          try {
            await discordChannel.messages.unpin(targetRow.messageId).catch(e => {
              if (e?.code !== 10003 && e?.code !== 10008) throw e;
            });
          } catch (e) {
            log("DEBUG", `Failed to unpin Discord message ${targetRow.messageId} in ${targetEndpoint.channelId}`, e);
          }
        }
      }
    }
  }
}
