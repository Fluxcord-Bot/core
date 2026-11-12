import Config from "./ConfigHandler.js";
import { BridgeEndpoint, BridgeGroup, MessageLink } from "../db/index.js";
import { Op } from "sequelize";
import { ChannelType as DiscordChannelType } from "discord.js";
import { pipelineCreate } from "./pipeline/adapters.js";
import { log } from "./Logger.js";
import { runBackfill } from "./BackfillQueue.js";
import { resolveFluxerClient } from "./FluxerClients.js";

let ran = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @param {any} channel
 * @param {any} endpoint
 * @param {number} cutoff
 * @param {import("discord.js").Client} discordClient
 */
async function sweepChannel(channel, endpoint, cutoff, discordClient) {
  const platform = endpoint.platform;

  if (platform === "discord" && (channel.type === DiscordChannelType.GuildForum || channel.type === DiscordChannelType.GuildMedia)) return 0;
  if (platform === "fluxer" && ((typeof channel.isForum === "function" && channel.isForum()) || (typeof channel.isMedia === "function" && channel.isMedia()))) return 0;

  const groupIds = [...new Set((await BridgeEndpoint.findAll({ where: { platform, channelId: endpoint.channelId }, attributes: ["groupId"], raw: true })).map(e => e.groupId))];
  const endpoints = await BridgeEndpoint.findAll({ where: { groupId: { [Op.in]: groupIds } }, raw: true });
  const endpointIds = new Set(endpoints.map(e => e.id));

  return runBackfill(endpoint.guildId, async () => {
    const collected = [];
    let before = undefined;
    while (true) {
      const page = await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });
      const values = [...page.values()];
      if (values.length === 0) break;
      collected.push(...values);
      if (new Date(values[values.length - 1].createdAt).getTime() < cutoff) break;
      before = values[values.length - 1].id;
    }
    if (collected.length === 0) return 0;

    const ids = collected.map(x => x.id);
    const existing = await MessageLink.findAll({
      where: { messageId: { [Op.in]: ids }, endpointId: { [Op.in]: [...endpointIds] } },
    });
    const bridgedIds = new Set(existing.map(x => x.messageId));
    const skipIds = new Set(
      [discordClient.user?.id, ...endpoints.filter(e => e.platform === platform).map(e => e.webhookId)].filter(Boolean)
    );
    const missed = collected
      .filter(
        m => new Date(m.createdAt).getTime() >= cutoff && !bridgedIds.has(m.id) && !skipIds.has(m.author?.id) && !m.webhookId
      )
      .reverse();

    let success = 0;
    for (const msg of missed) {
      try {
        if (platform === "fluxer") {
          await pipelineCreate(msg, { instanceId: endpoint.instanceId, execCommands: false });
        } else {
          await pipelineCreate(msg, { execCommands: false });
        }
        success++;
      } catch {}
      await sleep(500);
    }
    return success;
  });
}

/**
 * @param {import("discord.js").Client} discordClient
 */
export async function runStartupSync(discordClient) {
  if (ran) return;
  ran = true;

  if (!Config.StartupSyncEnabled) return;

  const endpoints = await BridgeEndpoint.findAll({ where: { kind: "channel" }, raw: true });
  const seen = new Map();
  for (const endpoint of endpoints) {
    seen.set(`${endpoint.platform}:${endpoint.channelId}`, endpoint);
  }

  const bridgeGroups = await BridgeGroup.findAll({ raw: true });
  log("META", `Startup sync running across ${seen.size} channels (${bridgeGroups.length} bridge groups)`);

  let total = 0;
  for (const [key, endpoint] of seen) {
    const [platform, channelId] = key.split(":");
    try {
      const newest = await MessageLink.findOne({
        where: { endpointId: endpoint.id },
        order: [["createdAt", "DESC"]],
        include: ["endpoint"],
      });
      if (!newest) continue;
      const cutoff = new Date(newest.createdAt).getTime() - 60_000;

      let client;
      try {
        if (platform === "discord") {
          client = discordClient;
        } else {
          client = resolveFluxerClient(endpoint.instanceId);
        }
        const channel = await client.channels.fetch(channelId);
        if (!channel) continue;
        const bridged = await sweepChannel(channel, endpoint, cutoff, discordClient);
        if (bridged > 0) log("META", `Startup sync replayed ${bridged} missed messages in ${platform} channel ${channelId}`);
        total += bridged;
      } catch (e) {
        log(platform === "discord" ? "DISCORD" : "FLUXER", `Startup sync failed for channel ${channelId}`, e);
      }
    } catch (e) {
      log("DB", `Startup sync failed for channel ${channelId}`, e);
    }
  }
  log("META", `Startup sync done, replayed ${total} missed messages`);
}
