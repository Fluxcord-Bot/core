import { ChannelMap } from "../db/index.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { log } from "./Logger.js";

export async function mirrorDiscordTopic(newChannel, discordClient, fluxerClient) {
  if (newChannel.type !== DiscordChannelType.GuildText && newChannel.type !== DiscordChannelType.GuildAnnouncement)
    return;
  const row = await ChannelMap.findOne({ where: { discordChannelId: newChannel.id }, raw: true });
  if (!row || row.autoMirrored || row.bridgeType === "fluxer2discord") return;
  let target;
  try {
    target = await fluxerClient.channels.fetch(row.fluxerChannelId);
  } catch {
    return;
  }
  if (!target || (!target.isText() && !target.isAnnouncement())) return;
  const topic = newChannel.topic ?? null;
  if ((target.topic ?? null) === topic) return;
  try {
    await target.edit({ topic: topic === null ? null : topic.slice(0, 1024) }); // i almost did 1234 omfg
  } catch (e) {
    log("FLUXER", `Failed to mirror topic for Discord channel ${newChannel.id} to Fluxer channel ${target.id}`, e); // as a reminder if i ever look in here, the log needs to be ERROR after i merge a pr
  }
}

export async function mirrorFluxerTopic(newChannel, discordClient, fluxerClient) {
  if (typeof newChannel.isThread === "function" && newChannel.isThread()) return;
  if (typeof newChannel.isText !== "function" || (!newChannel.isText() && !newChannel.isAnnouncement())) return;
  const row = await ChannelMap.findOne({ where: { fluxerChannelId: newChannel.id }, raw: true });
  if (!row || row.autoMirrored || row.bridgeType === "discord2fluxer") return;
  let target;
  try {
    target = await discordClient.channels.fetch(row.discordChannelId);
  } catch {
    return;
  }
  if (
    !target ||
    (target.type !== DiscordChannelType.GuildText && target.type !== DiscordChannelType.GuildAnnouncement)
  )
    return;
  const topic = newChannel.topic ?? null;
  if ((target.topic ?? null) === topic) return;
  try {
    await target.setTopic(topic === null ? null : topic.slice(0, 1024));
  } catch (e) {
    log("DISCORD", `Failed to mirror topic for Fluxer channel ${newChannel.id} to Discord channel ${target.id}`, e);
  }
}

export async function syncBridgeTopic(row, discordClient, fluxerClient, initiator) {
  if (row.autoMirrored) return;
  try {
    if (initiator === "fluxer") {
      const fluxerSource = await fluxerClient.channels.fetch(row.fluxerChannelId);
      if (fluxerSource?.topic && row.bridgeType !== "discord2fluxer") {
        await mirrorFluxerTopic(fluxerSource, discordClient, fluxerClient);
        return;
      }
      const discordSource = await discordClient.channels.fetch(row.discordChannelId);
      if (discordSource?.topic && row.bridgeType !== "fluxer2discord") {
        await mirrorDiscordTopic(discordSource, discordClient, fluxerClient);
      }
    } else {
      const discordSource = await discordClient.channels.fetch(row.discordChannelId);
      if (discordSource?.topic && row.bridgeType !== "fluxer2discord") {
        await mirrorDiscordTopic(discordSource, discordClient, fluxerClient);
        return;
      }
      const fluxerSource = await fluxerClient.channels.fetch(row.fluxerChannelId);
      if (fluxerSource?.topic && row.bridgeType !== "discord2fluxer") {
        await mirrorFluxerTopic(fluxerSource, discordClient, fluxerClient);
      }
    }
  } catch (e) {
    log("META", `Failed to sync topic for bridge discord=${row.discordChannelId} fluxer=${row.fluxerChannelId}`, e);
  }
}
