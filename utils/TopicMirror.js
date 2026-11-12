import { ChannelType as DiscordChannelType } from "discord.js";
import { BridgeEndpoint, BridgeGroup } from "../db/index.js";
import { Op } from "sequelize";
import { log } from "./Logger.js";
import { resolveFluxerClient } from "./FluxerClients.js";

function directionAllowed(sourcePlatform, targetPlatform, bridgeType) {
  if (sourcePlatform === targetPlatform) return bridgeType === "both";
  if (sourcePlatform === "fluxer") return bridgeType !== "discord2fluxer";
  return bridgeType !== "fluxer2discord";
}

/**
 * @param {any} sourceEndpoint
 * @param {string | null} topic
 * @param {import("discord.js").Client} [discordClient]
 * @returns {Promise<void>}
 */
export async function mirrorTopicFromEndpoint(sourceEndpoint, topic, discordClient) {
  const own = await BridgeEndpoint.findAll({
    where: { platform: sourceEndpoint.platform, channelId: sourceEndpoint.channelId },
    attributes: ["groupId"],
    raw: true,
  });
  const groupIds = [...new Set(own.map(e => e.groupId))];
  if (groupIds.length === 0) return;
  const groups = await BridgeGroup.findAll({ where: { id: { [Op.in]: groupIds } }, raw: true });
  const candidates = await BridgeEndpoint.findAll({ where: { groupId: { [Op.in]: groupIds }, kind: "channel" }, raw: true });

  /** @type {any[]} */
  const targets = [];
  for (const t of candidates) {
    if (t.platform === sourceEndpoint.platform && t.channelId === sourceEndpoint.channelId) continue;
    if (!directionAllowed(sourceEndpoint.platform, t.platform, groups.find(g => g.id === t.groupId)?.bridgeType)) continue;
    if (targets.some(x => `${x.platform}:${x.channelId}` === `${t.platform}:${t.channelId}`)) continue;
    targets.push(t);
  }

  for (const target of targets) {
    try {
      if (target.platform === "fluxer") {
        const fluxerClient = resolveFluxerClient(target.instanceId);
        const channel = await fluxerClient.channels.fetch(target.channelId);
        if (!channel || (!channel.isText() && !channel.isAnnouncement())) continue;
        if ((channel.topic ?? null) === topic) continue;
        await channel.edit({ topic: topic === null ? null : topic.slice(0, 1024) });
      } else {
        if (!discordClient) continue;
        const channel = await discordClient.channels.fetch(target.channelId);
        if (!channel || (channel.type !== DiscordChannelType.GuildText && channel.type !== DiscordChannelType.GuildAnnouncement)) continue;
        if ((channel.topic ?? null) === topic) continue;
        await channel.setTopic(topic === null ? null : topic.slice(0, 1024));
      }
    } catch (e) {
      log("META", `Failed to mirror topic to ${target.platform} channel ${target.channelId}`, e);
    }
  }
}

/**
 * @param {any} newChannel
 * @param {import("discord.js").Client} discordClient
 */
export async function mirrorDiscordTopic(newChannel, discordClient) {
  if (newChannel.type !== DiscordChannelType.GuildText && newChannel.type !== DiscordChannelType.GuildAnnouncement) return;
  const source = await BridgeEndpoint.findOne({ where: { platform: "discord", channelId: newChannel.id, kind: "channel" }, raw: true });
  if (!source) return;
  await mirrorTopicFromEndpoint(source, newChannel.topic ?? null, discordClient);
}

/**
 * @param {any} newChannel
 */
export async function mirrorFluxerTopic(newChannel) {
  if (typeof newChannel.isThread === "function" && newChannel.isThread()) return;
  if (typeof newChannel.isText !== "function" || (!newChannel.isText() && !newChannel.isAnnouncement())) return;
  const source = await BridgeEndpoint.findOne({
    where: { platform: "fluxer", channelId: newChannel.id, kind: "channel" },
    raw: true,
  });
  if (!source) return;
  await mirrorTopicFromEndpoint(source, newChannel.topic ?? null, undefined);
}
