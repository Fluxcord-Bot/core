import Config from "./ConfigHandler.js";
import { ChannelMap, MessageMap } from "../db/index.js";
import { Op } from "sequelize";
import { ChannelType as DiscordChannelType } from "discord.js";
import { FluxerCreateMessageHandler } from "./FluxerHandler.js";
import { DiscordCreateMessageHandler } from "./DiscordHandler.js";
import { log } from "./Logger.js";
import { runBackfill } from "./BackfillQueue.js";

let ran = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * @param {any} channel
 * @param {any} map
 * @param {number} cutoff
 * @param {"discordMessageId" | "fluxerMessageId"} idColumn
 * @param {"discord" | "fluxer"} side
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
async function sweepSide(channel, map, cutoff, idColumn, side, discordClient, fluxerClient) {
  if (side === "discord") {
    if (channel.type === DiscordChannelType.GuildForum || channel.type === DiscordChannelType.GuildMedia) return 0;
  } else if (
    (typeof channel.isForum === "function" && channel.isForum()) ||
    (typeof channel.isMedia === "function" && channel.isMedia())
  ) {
    return 0;
  }

return runBackfill(map.discordGuildId, async () => {
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
  const alreadyBridged = await MessageMap.findAll({
    where: {
      [idColumn]: { [Op.in]: ids },
    },
  });
  const bridgedIds = new Set(alreadyBridged.map(x => x[idColumn]));
  const skipIds = new Set(
    [discordClient.user?.id, fluxerClient.user?.id, map.discordWebhookId, map.fluxerWebhookId].filter(Boolean)
  );
  const missed = collected
    .filter(
      m =>
        new Date(m.createdAt).getTime() >= cutoff &&
        !bridgedIds.has(m.id) &&
        !skipIds.has(m.author?.id) &&
        !m.webhookId
    )
    .reverse();

  let success = 0;
  for (const msg of missed) {
    try {
      if (side === "fluxer") {
        await FluxerCreateMessageHandler(msg, fluxerClient, discordClient, map.fluxerGuildId);
      } else {
        await DiscordCreateMessageHandler(msg, discordClient, fluxerClient, true);
      }
      success++;
    } catch { }
    await sleep(500);
  }
  return success;
});
}

export async function runStartupSync(discordClient, fluxerClient) {
  if (ran) return;
  ran = true;

  if (!Config.StartupSyncEnabled) return;

  const maps = await ChannelMap.findAll();
  log("META", `Startup sync running across ${maps.length} bridges`);

  let total = 0;
  for (const map of maps) {
    try {
      const newest = await MessageMap.findOne({
        where: { channelMapId: map.id },
        order: [["createdAt", "DESC"]],
      });
      if (!newest) continue;
      const cutoff = new Date(newest.createdAt).getTime() - 60_000;

      for (const side of ["discord", "fluxer"]) {
        const channelId = side === "discord" ? map.discordChannelId : map.fluxerChannelId;
        const idColumn = side === "discord" ? "discordMessageId" : "fluxerMessageId";
        try {
          const client = side === "discord" ? discordClient : fluxerClient;
          const channel = await client.channels.fetch(channelId);
          if (!channel) continue;
          const bridged = await sweepSide(channel, map, cutoff, idColumn, side, discordClient, fluxerClient);
          if (bridged > 0) log("META", `Startup sync replayed ${bridged} missed messages in ${side} channel ${channelId}`);
          total += bridged;
        } catch (e) {
          log(side === "discord" ? "DISCORD" : "FLUXER", `Startup sync failed for channel ${channelId} (map ${map.id})`, e);
        }
      }
    } catch (e) {
      log("DB", `Startup sync failed for map ${map.id}`, e);
    }
  }
  log("META", `Startup sync done, replayed ${total} missed messages`);
}
