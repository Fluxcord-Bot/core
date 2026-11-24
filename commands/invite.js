import { Message as FluxerMessage } from "@fluxerjs/core";
import { GuildMap } from "../db/index.js";
import { getFluxerInviteBaseUrl } from "../utils/GetFluxerUrls.js";
import { findEndpoints, fanoutTargets } from "../utils/Bridging.js";
import { instanceIdOfClient, resolveFluxerClient } from "../utils/FluxerClients.js";

const MAX_INVITE_TARGETS = 15;

function targetKey(target) {
  return `${target.platform}:${target.instanceId || "default"}:${target.guildId}`;
}

function instanceTag(target) {
  const instanceId = target.instanceId || "default";
  return target.platform === "fluxer" && instanceId !== "default" ? ` [${instanceId}]` : "";
}

async function discordInvite(target, discordClient) {
  const guild = await discordClient.guilds.fetch(target.guildId);
  if (guild.vanityURLCode) {
    return `Invite code for **${guild.name}**${instanceTag(target)}:\n<https://discord.gg/${guild.vanityURLCode}>`;
  }
  const invite = await guild.invites.create(target.channelId, { maxAge: 172800 });
  return `Invite code for **${guild.name}**${instanceTag(target)} (valid for 2 days):\n<https://discord.gg/${invite.code}>`;
}

async function fluxerInvite(target) {
  const instanceId = target.instanceId || "default";
  const client = resolveFluxerClient(instanceId);
  const guild = await client.guilds.fetch(target.guildId);
  const inviteBase = await getFluxerInviteBaseUrl(instanceId);
  if (guild.vanityURLCode) {
    return `Invite code for **${guild.name}**${instanceTag(target)}:\n<${inviteBase}/${guild.vanityURLCode}>`;
  }
  const channel = await client.channels.fetch(target.channelId);
  if (!channel) throw new Error("channel not found");
  const invite = await channel.createInvite({ maxAge: 172800 });
  return `Invite code for **${guild.name}**${instanceTag(target)} (valid for 2 days):\n<${inviteBase}/${invite.code}>`;
}

async function inviteLine(target, discordClient) {
  try {
    if (target.platform === "discord") return await discordInvite(target, discordClient);
    return await fluxerInvite(target);
  } catch (e) {
    return `Couldn't create an invite for ${target.platform} ${target.guildId}: ${e?.message ?? e}`;
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

    const sourceEndpoints = await findEndpoints(sourcePlatform, message.channelId);
    if (sourceEndpoints.length === 0) {
      await message.reply("This channel isn't part of a bridge.");
      return;
    }

    const guildMap = await GuildMap.findOne({ where: { guildId: message.guildId, guildType: sourcePlatform } });
    if (guildMap?.inviteEnabled === false) {
      await message.reply("The invite command is disabled in this guild.");
      return;
    }

    const members = await fanoutTargets(sourceEndpoints[0]);
    const channelMembers = members.filter(x => x.kind === "channel");
    const pool = channelMembers.length > 0 ? channelMembers : members;

    const seen = new Set([`${sourcePlatform}:${sourceInstanceId}:${message.guildId}`]);
    const targets = [];
    for (const member of pool) {
      const key = targetKey(member);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(member);
    }

    if (targets.length === 0) {
      await message.reply("This channel isn't part of a bridge.");
      return;
    }

    const limited = targets.slice(0, MAX_INVITE_TARGETS);
    const lines = [];
    for (const target of limited) {
      lines.push(await inviteLine(target, discordClient));
    }

    let content = lines.join("\n");
    const remaining = targets.length - limited.length;
    if (remaining > 0) content += `\n…and ${remaining} more bridged server(s)/community(ies).`;
    if (content.length > 1900) content = `${content.slice(0, 1897)}...`;

    await message.reply(content);
  },
};

export default command;
