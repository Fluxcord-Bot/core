import { EmbedBuilder } from "@fluxerjs/core";
import { GuildMap, MessageLink } from "../db/index.js";
import { genMsgLink } from "./GenMsgLink.js";
import { resolveFluxerClient } from "./FluxerClients.js";

export const DEFAULT_INFO_EMOJI = "ℹ️";

/**
 * @param {string | null} guildId
 */
export async function getInfoReactionEmoji(guildId) {
  if (!guildId) return DEFAULT_INFO_EMOJI;
  const guildMap = await GuildMap.findOne({ where: { guildId } });
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
  const rows = await MessageLink.findAll({ where: { messageId: message.id }, include: ["endpoint"] });
  const local = rows.find(r => r.endpoint?.channelId === message.channelId) ?? rows[0];
  if (!local?.endpoint) return;

  const target =
    rows.find(r => r.endpoint?.platform !== local.endpoint.platform) ?? rows.find(r => r.messageId !== local.messageId);
  if (!target?.endpoint) return;

  let targetMessage;
  try {
    if (target.endpoint.platform === "fluxer") {
      const channel = await resolveFluxerClient(target.endpoint.instanceId).channels.fetch(target.endpoint.channelId);
      if (!channel) return;
      targetMessage = await channel.messages.fetch(target.messageId);
    } else {
      const channel = await discordClient.channels.fetch(target.endpoint.channelId);
      if (!channel) return;
      targetMessage = await channel.messages.fetch(target.messageId);
    }
  } catch {
    return;
  }
  if (!targetMessage) return;

  const embed = new EmbedBuilder();
  embed.setURL(await genMsgLink(message));
  embed.setTitle(`Message ${targetMessage.id} on #${targetMessage.channel.name}`);
  embed.setDescription(`[Jump to message on original platform](${await genMsgLink(targetMessage)})`);
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
