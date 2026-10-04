import { ChannelType as DiscordChannelType } from "discord.js";
import { ChannelType as FluxerChannelType } from "@fluxerjs/core";
import { isBridgeToggleEnabled } from "./BridgeToggle.js";
import { log } from "./Logger.js";

export function isVoiceChannel(channel) {
  if (!channel) return false;
  return (
    channel.type === DiscordChannelType.GuildVoice ||
    channel.type === DiscordChannelType.GuildStageVoice ||
    channel.type === FluxerChannelType.GuildVoice
  );
}

export function isDiscordAnnouncementChannel(channel) {
  if (!channel) return false;
  return channel.type === DiscordChannelType.GuildAnnouncement;
}

export function isFluxerAnnouncementChannel(channel) {
  if (!channel) return false;
  if (channel.type === FluxerChannelType.GuildAnnouncement) return true;
  try {
    return channel.isAnnouncement() === true;
  } catch {
    return false;
  }
}

export function resolveChannelVoiceText(discordChannel, fluxerChannel) {
  if (isVoiceChannel(discordChannel) || isVoiceChannel(fluxerChannel))
    return "voice";
  if (
    isDiscordAnnouncementChannel(discordChannel) ||
    isFluxerAnnouncementChannel(fluxerChannel)
  )
    return "announcement";
  return "text";
}

export function isAnnouncementPairAllowed(discordChannel, fluxerChannel) {
  return (
    isVoiceChannel(discordChannel) === isVoiceChannel(fluxerChannel)
  );
}

export async function maybePublishDiscordMessage(
  discordClient,
  channelMap,
  messageId,
) {
  let enabled = true;
  try {
    enabled = await isBridgeToggleEnabled(channelMap, "autoPublishEnabled");
  } catch {}
  if (!enabled) return false;
  let channel = null;
  try {
    channel = await discordClient.channels.fetch(channelMap.discordChannelId);
  } catch {
    return false;
  }
  if (!isDiscordAnnouncementChannel(channel)) return false;
  try {
    const message = await channel.messages.fetch(messageId);
    if (!message) return false;
    if (message.crosspostable === false) return false;
    await message.crosspost();
    return true;
  } catch (e) {
    log(
      "DISCORD",
      `Failed to auto publish announcement message ${messageId}`,
      e,
    );
    return false;
  }
}

export async function maybePublishFluxerMessage(
  fluxerClient,
  channelMap,
  messageId,
) {
  let enabled = true;
  try {
    enabled = await isBridgeToggleEnabled(channelMap, "autoPublishEnabled");
  } catch {}
  if (!enabled || !messageId) return false;
  let channel = null;
  try {
    channel = await fluxerClient.channels.fetch(channelMap.fluxerChannelId);
  } catch {
    return false;
  }
  if (!isFluxerAnnouncementChannel(channel)) return false;
  const paths = [
    `/channels/${channelMap.fluxerChannelId}/messages/${messageId}/crosspost`,
    `/channels/${channelMap.fluxerChannelId}/messages/${messageId}/publish`,
  ];
  for (const path of paths) {
    try {
      await fluxerClient.rest.post(path, { body: {} });
      return true;
    } catch (e) {
      const status = e?.status ?? e?.statusCode ?? e?.cause?.statusCode;
      if (status === 404) continue;
      log(
        "FLUXER",
        `Failed to auto publish announcement message ${messageId}`,
        e,
      );
      return false;
    }
  }
  return false;
}
