import { Op } from "sequelize";
import { Routes as FluxerRoutes } from "@fluxerjs/core";
import { MessageLink } from "../../db/index.js";
import { findEndpoints } from "../Bridging.js";
import { resolveDiscordThreadChannel } from "../DiscordThreadResolver.js";
import { resolveFluxerClient } from "../FluxerClients.js";
import { log } from "../Logger.js";
import { collectTargets } from "./targets.js";

export async function handlePins(platform, payload, options = {}) {
  if (platform === "discord") return handleDiscordPins(payload, options);
  return handleFluxerPins(payload, options);
}

async function handleDiscordPins(channel, options) {
  log("DEBUG", `DiscordPinsUpdate received channelId=${channel.id}`);

  const endpoints = await findEndpoints("discord", channel.id);
  const sourceKind = endpoints[0]?.kind ?? "channel";
  if (sourceKind === "thread") return;

  const sourceEndpoints = endpoints.filter(e => e.kind === "channel");
  if (sourceEndpoints.length === 0) return;

  const pinnedMessages = await channel.messages.fetchPins();
  const pinnedIds = pinnedMessages.items.map(x => x.message.id);

  const pinnedRows = await MessageLink.findAll({
    where: { messageId: { [Op.in]: pinnedIds } },
    include: ["endpoint"],
  });
  const ownPinnedGroups = new Set(
    pinnedRows.filter(r => r.endpoint?.platform === "discord" && r.endpoint?.channelId === channel.id).map(r => r.linkGroup)
  );

  for (const entry of await collectTargets(sourceEndpoints, "discord", { kind: "channel", excludeChannelId: channel.id })) {
    if (entry.endpoints[0].platform !== "fluxer") continue;
    const targetEndpoint = entry.endpoints[0];
    const fluxerClient = resolveFluxerClient(targetEndpoint.instanceId);

    const fluxerChannel = await fluxerClient.channels.fetch(targetEndpoint.channelId).catch(() => null);
    if (!fluxerChannel?.isTextBased?.()) continue;

    const fluxerPinned = await fluxerChannel.fetchPinnedMessages();
    const fluxerPinnedIds = fluxerPinned.map(x => x.id);

    const localRows = await MessageLink.findAll({
      where: { linkGroup: [...ownPinnedGroups], endpointId: targetEndpoint.id },
    });

    for (const local of localRows) {
      if (!fluxerPinnedIds.includes(local.messageId)) {
        try {
          const msg = await (await fluxerClient.channels.fetch(targetEndpoint.channelId)).messages.fetch(local.messageId);
          await msg.pin();
        } catch {}
      }
    }

    const targetPinnedRows = await MessageLink.findAll({
      where: { messageId: { [Op.in]: fluxerPinnedIds }, endpointId: targetEndpoint.id },
    });
    for (const targetRow of targetPinnedRows) {
      const sourceCopy = await MessageLink.findOne({
        where: { linkGroup: targetRow.linkGroup, endpointId: sourceEndpoints[0].id },
      });
      if (sourceCopy && !pinnedIds.includes(sourceCopy.messageId)) {
        try {
          await fluxerClient.rest.patch(FluxerRoutes.channelMessage(targetEndpoint.channelId, targetRow.messageId), {
            body: { pinned: false },
          });
        } catch {}
      }
    }
  }
}

async function handleFluxerPins(payload, options) {
  const instanceId = options.instanceId ?? "default";
  const discordClient = options.discordClient;
  log("DEBUG", `FluxerPinsUpdate received channelId=${payload.channelId} instance=${instanceId}`);

  const endpoints = await findEndpoints("fluxer", payload.channelId);
  const sourceKind = endpoints[0]?.kind ?? "channel";
  if (sourceKind === "thread") return;

  const sourceEndpoints = endpoints.filter(e => e.kind === "channel");
  if (sourceEndpoints.length === 0) return;

  const fluxerClient = resolveFluxerClient(instanceId);
  const channel = await fluxerClient.channels.fetch(payload.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const pinned = await channel.fetchPinnedMessages();
  const pinnedIds = pinned.map(x => x.id);

  const pinnedRows = await MessageLink.findAll({
    where: { messageId: { [Op.in]: pinnedIds } },
    include: ["endpoint"],
  });
  const ownPinnedGroups = new Set(
    pinnedRows.filter(r => r.endpoint?.platform === "fluxer" && r.endpoint?.channelId === payload.channelId).map(r => r.linkGroup)
  );

  for (const entry of await collectTargets(sourceEndpoints, "fluxer", { kind: "channel", excludeChannelId: payload.channelId })) {
    if (entry.endpoints[0].platform !== "discord") continue;
    const targetEndpoint = entry.endpoints[0];

    const discordChannel = await discordClient.channels.fetch(targetEndpoint.channelId).catch(() => null);
    if (!discordChannel?.isTextBased?.()) continue;
    if (await resolveDiscordThreadChannel(discordClient, targetEndpoint.channelId)) continue;

    const discordPinned = await discordChannel.messages.fetchPins();
    const discordPinnedIds = discordPinned.items.map(x => x.message.id);
    const localRows = await MessageLink.findAll({
      where: { linkGroup: [...ownPinnedGroups], endpointId: targetEndpoint.id },
    });

    for (const local of localRows) {
      if (!discordPinnedIds.includes(local.messageId)) {
        try {
          await discordChannel.messages.pin(local.messageId).catch(e => {
            if (e?.code !== 10003) throw e;
          });
        } catch {}
      }
    }

    const targetPinnedRows = await MessageLink.findAll({
      where: { messageId: { [Op.in]: discordPinnedIds }, endpointId: targetEndpoint.id },
    });
    for (const targetRow of targetPinnedRows) {
      const sourceCopy = await MessageLink.findOne({
        where: { linkGroup: targetRow.linkGroup, endpointId: sourceEndpoints[0].id },
      });
      if (sourceCopy && !pinnedIds.includes(sourceCopy.messageId)) {
        try {
          await discordChannel.messages.unpin(targetRow.messageId).catch(e => {
            if (e?.code !== 10003) throw e;
          });
        } catch {}
      }
    }
  }
}
