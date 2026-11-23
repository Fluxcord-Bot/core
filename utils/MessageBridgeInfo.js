import { EmbedBuilder } from "@fluxerjs/core";
import { GuildMap, MessageLink } from "../db/index.js";
import { findLinkSiblings } from "./Bridging.js";
import { genMsgLink } from "./GenMsgLink.js";
import { resolveFluxerClient } from "./FluxerClients.js";
import { log } from "./Logger.js";

export const DEFAULT_INFO_EMOJI = "ℹ️";

/**
 * @param {string | null} guildId
 */
export async function getInfoReactionEmoji(guildId, guildType) {
  if (!guildId) return DEFAULT_INFO_EMOJI;
  const guildMap = await GuildMap.findOne({ where: guildType ? { guildId, guildType } : { guildId } });
  return guildMap?.infoReactionEmoji || DEFAULT_INFO_EMOJI;
}

/**
 * @param {string | null} emojiId
 * @param {string} emojiName
 * @param {string} configured
 */
export function isInfoReactionEmoji(emojiId, emojiName, configured) {
  if (emojiId) return false;
  const strip = value => (value ?? "").replace(/\uFE0F/g, "");
  return strip(emojiName) === strip(configured);
}

/**
 * @param {import("@fluxerjs/core").Message | import("discord.js").Message} message
 * @param {import("@fluxerjs/core").User | import("discord.js").User} user
 * @param {import("discord.js").Client} discordClient
 */
export async function sendBridgeInfo(message, user, discordClient) {
  const row = (await MessageLink.findAll({ where: { messageId: message.id }, include: ["endpoint"] })).find(
    r => r.endpoint?.channelId === message.channelId
  );
  if (!row?.endpoint) {
    log("DEBUG", `BridgeInfo skip message=${message.id} reason=noRows`);
    return;
  }

  const siblings = await findLinkSiblings(row.linkGroup);
  const local = siblings.find(s => s.endpoint?.id === row.endpoint.id) ?? siblings[0];
  if (siblings.length < 2) {
    log("DEBUG", `BridgeInfo skip message=${message.id} reason=noTarget`);
    return;
  }

  const sourceRow = [...siblings].sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))[0];
  let targetMessage;
  try {
    if (sourceRow.endpoint.platform === "fluxer") {
      const channel = await resolveFluxerClient(sourceRow.endpoint.instanceId).channels.fetch(sourceRow.endpoint.channelId);
      if (!channel) return;
      targetMessage = await channel.messages.fetch(sourceRow.messageId);
    } else {
      const channel = await discordClient.channels.fetch(sourceRow.endpoint.channelId);
      if (!channel) return;
      targetMessage = await channel.messages.fetch(sourceRow.messageId);
    }
  } catch (e) {
    log("DEBUG", `BridgeInfo skip message=${message.id} reason=targetFetchFailed`, e);
    return;
  }
  if (!targetMessage) {
    log("DEBUG", `BridgeInfo skip message=${message.id} reason=noTargetMessage`);
    return;
  }

  const platformName = sourceRow.endpoint.platform === "fluxer" ? "Fluxer" : "Discord";
  const embed = new EmbedBuilder();
  embed.setURL(await genMsgLink(message));
  embed.setTitle(`Message ${targetMessage.id} on #${targetMessage.channel.name}`);
  embed.setDescription(`[Jump to message on original platform (${platformName})](${await genMsgLink(targetMessage)})`);
  const author = targetMessage.author;
  embed.addFields({
    name: "Author",
    value: `@${author.username}${author.discriminator && author.discriminator !== "0000" ? `#${author.discriminator}` : ""} (${author.id})`,
    inline: true,
  });

  const dm = await user.createDM();
  await dm.send({ embeds: [embed] });
  return true;
}
