import { Message as FluxerMessage } from "@fluxerjs/core";
import { GuildMap } from "../db/index.js";
import { getFluxerInviteBaseUrl } from "../utils/GetFluxerUrls.js";
import { instanceIdOfClient, resolveFluxerClient } from "../utils/FluxerClients.js";
import { guildLinkedMaps } from "../utils/BridgeToggle.js";
import { ChannelType } from "discord.js";

const MAX_INVITE_TARGETS = 15;

function targetKey(target) {
  return `${target.platform}:${target.fluxerInstanceId || "default"}:${target.guildId}`;
}

function instanceTag(target) {
  const fluxerInstanceId = target.fluxerInstanceId || "default";
  return target.platform === "fluxer" && fluxerInstanceId !== "default" ? ` [${fluxerInstanceId}]` : "";
}

/**
 * @param {GuildMap} target
 * @param {import("discord.js").Client} discordClient
 * @returns
 */
async function discordInvite(target, discordClient) {
  const guild = await discordClient.guilds.fetch(target.guildId);
  if (target.inviteEnabled === false) {
    return `Invite disabled for ${guild.name}`;
  }
  if (guild.vanityURLCode) {
    return `Invite code for **${guild.name}**${instanceTag(target)}:\n<https://discord.gg/${guild.vanityURLCode}>`;
  }
  const channel = (await guild.channels.fetch()).find(x => x.type === ChannelType.GuildText);
  const invite = await guild.invites.create(channel, { maxAge: 172800 });
  return `Invite code for **${guild.name}**${instanceTag(target)} (valid for 2 days):\n<https://discord.gg/${invite.code}>`;
}

/**
 * @param {GuildMap} target
 */
async function fluxerInvite(target) {
  const fluxerInstanceId = target.fluxerInstanceId || "default";
  const client = resolveFluxerClient(fluxerInstanceId);
  const guild = await client.guilds.fetch(target.guildId);
  if (target.inviteEnabled === false) {
    return `Invite disabled for ${guild.name}`;
  }
  const inviteBase = await getFluxerInviteBaseUrl(fluxerInstanceId);
  if (guild.vanityURLCode) {
    return `Invite code for **${guild.name}**${instanceTag(target)}:\n<${inviteBase}/${guild.vanityURLCode}>`;
  }
  const invite = await guild.channels.first()?.createInvite({ maxAge: 172800 });
  return `Invite code for **${guild.name}**${instanceTag(target)} (valid for 2 days):\n<${inviteBase}/${invite.code}>`;
}

/**
 * @param {GuildMap} target
 * @param {import("discord.js").Client} discordClient
 */
async function inviteLine(target, discordClient) {
  try {
    if (target.guildType === "discord") return await discordInvite(target, discordClient);
    return await fluxerInvite(target);
  } catch (e) {
    return `Couldn't create an invite for ${target.guildType} ${target.guildId}: ${e?.message ?? e}`;
  }
}

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "invite",
  description: "Get an invite code from the other side",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    const sourcePlatform = message instanceof FluxerMessage ? "fluxer" : "discord";
    const sourceInstanceId = sourcePlatform === "fluxer" ? (instanceIdOfClient(fluxerClient) ?? "default") : "default";

    const guildMap = await GuildMap.findOne({ where: { guildId: message.guildId, guildType: sourcePlatform } });
    if (guildMap?.inviteEnabled === false) {
      await message.reply("The invite command is disabled in this guild.");
      return;
    }

    const maps = await guildLinkedMaps(message.guildId, sourcePlatform);

    const limited = maps.slice(0, MAX_INVITE_TARGETS);
    const lines = [];
    for (const target of limited) {
      if (target.guildId === message.guildId) continue;
      lines.push(await inviteLine(target, discordClient));
    }

    let content = lines.join("\n");
    const remaining = maps.length - limited.length;
    if (remaining > 0) content += `\n…and ${remaining} more bridged server(s)/community(ies).`;
    if (content.length > 1900) content = `${content.slice(0, 1897)}...`;

    await message.reply(content);
  },
};

export default command;
