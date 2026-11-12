import { GuildChannel as FluxerGuildChannel } from "@fluxerjs/core";
import { GuildChannel as DiscordGuildChannel } from "discord.js";
import { Op } from "sequelize";
import { BridgeEndpoint, BridgeGroup, MessageLink, VoiceChannelMap } from "../db/index.js";
import { invalidateFluxerWebhookCache } from "./Webhooks.js";
import { findOrCreateGuildMap } from "./Bridging.js";

/**
 * @param {any} channel
 * @param {"discord" | "fluxer"} platform
 * @param {string} label
 * @returns {Promise<{ id: string, token: string } | null>}
 */
export async function createWebhookFor(channel, platform, label) {
  try {
    if (platform === "fluxer") {
      if (!(channel instanceof FluxerGuildChannel)) return null;
      const webhook = await channel.createWebhook({ name: label });
      invalidateFluxerWebhookCache(channel.id);
      return { id: webhook.id, token: webhook.token ?? "" };
    }
    if (!(channel instanceof DiscordGuildChannel)) return null;
    const webhook = await channel.createWebhook({ name: label });
    return { id: webhook.id, token: webhook.token };
  } catch {
    return null;
  }
}

function webhookNeededForTarget(platform, bridgeType) {
  if (bridgeType === "both") return true;
  return platform === "fluxer" ? bridgeType === "discord2fluxer" : bridgeType === "fluxer2discord";
}

/**
 * @param {object} spec
 * @param {"discord" | "fluxer"} spec.platform
 * @param {string} [spec.instanceId]
 * @param {any} spec.channel
 * @param {string} [spec.otherLabel]
 * @param {boolean} [spec.skipWebhook]
 */
async function buildEndpoint(spec) {
  const platform = spec.platform;
  const guildId = spec.channel.guildId;
  const guildMap = await findOrCreateGuildMap(platform, guildId, spec.instanceId ?? "default");
  let webhookId = null;
  let webhookToken = null;
  if (!spec.skipWebhook) {
    const webhook = await createWebhookFor(
      spec.channel,
      platform,
      `Fluxcord Bridge (${spec.channel.id} (${platform === "fluxer" ? "F" : "D"}) ${spec.otherLabel ?? ""})`
    );
    if (webhook) {
      webhookId = webhook.id;
      webhookToken = webhook.token;
    }
  }
  return {
    platform,
    instanceId: spec.instanceId ?? "default",
    channelId: spec.channel.id,
    guildId,
    webhookId,
    webhookToken,
    kind: "channel",
    autoMirrored: false,
    parentEndpointId: null,
    guildMapId: guildMap.id,
  };
}

/**
 * @param {string} bridgeType
 * @param {object[]} specs
 * @param {import("discord.js").Client} discordClient
 */
export async function createBridgeGroup(bridgeType, specs, discordClient) {
  const group = await BridgeGroup.create({ bridgeType });
  const endpoints = [];
  for (const spec of specs) {
    const row = await BridgeEndpoint.create({
      ...(await buildEndpoint({
        ...spec,
        skipWebhook: spec.skipWebhook ?? !webhookNeededForTarget(spec.platform, bridgeType),
      })),
      groupId: group.id,
    });
    endpoints.push(row);
  }
  void discordClient;
  return { group, endpoints };
}

/**
 * @param {string} bridgeType
 * @param {object} specA current side
 * @param {object} specB other side
 * @param {import("discord.js").Client} discordClient
 */
export async function setupBridgePair(bridgeType, specA, specB, discordClient) {
  const groupsOf = async spec => {
    const eps = await BridgeEndpoint.findAll({
      where: { platform: spec.platform, channelId: spec.channel.id },
      raw: true,
    });
    return [...new Set(eps.map(e => e.groupId))];
  };
  const [groupsA, groupsB] = await Promise.all([groupsOf(specA), groupsOf(specB)]);
  const involved = [...new Set([...groupsA, ...groupsB])];
  if (involved.length === 0 || bridgeType !== "both") {
    return createBridgeGroup(bridgeType, [specA, specB], discordClient);
  }

  const groups = await BridgeGroup.findAll({ where: { id: { [Op.in]: involved } } });
  if (groups.length === 0 || !groups.every(g => g.bridgeType === "both")) {
    return createBridgeGroup(bridgeType, [specA, specB], discordClient);
  }

  const targetGroup = groups[0];
  const rest = groups.slice(1);
  const existingInTarget = await BridgeEndpoint.findAll({ where: { groupId: targetGroup.id } });
  const alreadyThere = new Set(existingInTarget.map(e => `${e.platform}:${e.channelId}:${e.instanceId}`));

  const endpoints = [...existingInTarget];
  for (const spec of [specA, specB]) {
    if (alreadyThere.has(`${spec.platform}:${spec.channel.id}:${spec.instanceId ?? "default"}`)) continue;
    const row = await BridgeEndpoint.create({
      ...(await buildEndpoint({
        ...spec,
        skipWebhook: spec.skipWebhook ?? !webhookNeededForTarget(spec.platform, "both"),
      })),
      groupId: targetGroup.id,
    });
    endpoints.push(row);
    alreadyThere.add(`${spec.platform}:${spec.channel.id}:${spec.instanceId ?? "default"}`);
  }

  for (const group of rest) {
    const moved = await BridgeEndpoint.findAll({ where: { groupId: group.id } });
    for (const ep of moved) {
      const key = `${ep.platform}:${ep.channelId}:${ep.instanceId}`;
      if (alreadyThere.has(key)) {
        await MessageLink.destroy({ where: { endpointId: ep.id } });
        await ep.destroy();
        continue;
      }
      ep.groupId = targetGroup.id;
      await ep.save();
      alreadyThere.add(key);
      endpoints.push(ep);
    }
    await group.destroy();
  }

  return { group: targetGroup, endpoints, merged: rest.length + 1 };
}

/**
 * @param {string} channelId
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export async function removeChannelBridges(channelId, discordClient, fluxerClient) {
  const endpoints = await BridgeEndpoint.findAll({ where: { channelId } });
  if (endpoints.length === 0) return 0;

  const endpointIds = endpoints.map(e => e.id);
  const groupIds = [...new Set(endpoints.map(e => e.groupId))];

  await MessageLink.destroy({ where: { endpointId: { [Op.in]: endpointIds } } });
  await VoiceChannelMap.destroy({ where: { [Op.or]: [{ discordChannelId: channelId }, { fluxerChannelId: channelId }] } });

  for (const endpoint of endpoints) {
    if (endpoint.autoMirrored) continue;
    if (endpoint.platform === "discord" && endpoint.webhookId) {
      try {
        await discordClient.deleteWebhook(endpoint.webhookId, { token: endpoint.webhookToken ?? undefined });
      } catch {}
    } else if (endpoint.platform === "fluxer" && endpoint.webhookId) {
      try {
        const channel = await fluxerClient.channels.fetch(endpoint.channelId);
        const webhooks = await channel?.fetchWebhooks();
        const webhook = webhooks?.find?.(x => x.id === endpoint.webhookId);
        await webhook?.delete();
        invalidateFluxerWebhookCache(endpoint.channelId);
      } catch {}
    }
  }

  await BridgeEndpoint.destroy({ where: { id: { [Op.in]: endpointIds } } });

  for (const groupId of groupIds) {
    const remaining = await BridgeEndpoint.findAll({ where: { groupId } });
    if (remaining.length < 2) {
      await MessageLink.destroy({ where: { endpointId: { [Op.in]: remaining.map(e => e.id) } } });
      await BridgeEndpoint.destroy({ where: { id: { [Op.in]: remaining.map(e => e.id) } } });
      await BridgeGroup.destroy({ where: { id: groupId } });
    }
  }

  return endpoints.length;
}

/**
 * @param {string} guildId
 */
export async function channelIdsForGuild(guildId) {
  const endpoints = await BridgeEndpoint.findAll({
    where: { guildId },
    attributes: ["channelId"],
    raw: true,
  });
  return [...new Set(endpoints.map(e => e.channelId))];
}

/**
 * @param {string} linkGroup
 */
export async function detachMessageGroup(linkGroup) {
  const rows = await MessageLink.findAll({ where: { linkGroup } });
  const messageIds = rows.map(r => r.messageId);
  await MessageLink.update({ replyId: null }, { where: { replyId: { [Op.in]: messageIds } } });
  await MessageLink.destroy({ where: { linkGroup } });
  return rows.length > 0;
}
