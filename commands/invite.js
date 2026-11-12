import { Message as FluxerMessage } from "@fluxerjs/core";
import { BridgeEndpoint, BridgeGroup, GuildMap } from "../db/index.js";
import { Op } from "sequelize";
import { getFluxerInviteBaseUrl } from "../utils/GetFluxerUrls.js";
import { resolveFluxerClient } from "../utils/FluxerClients.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "invite",
  description: "Get an invite code from the other side",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    const sourcePlatform = message instanceof FluxerMessage ? "fluxer" : "discord";
    const endpoints = await BridgeEndpoint.findAll({
      where: { guildId: message.guildId, platform: sourcePlatform, kind: "channel" },
      raw: true,
    });

    if (endpoints.length === 0) {
      await message.reply("This channel isn't part of a bridge.");
      return;
    }

    const groupIds = [...new Set(endpoints.map(x => x.groupId))];
    const groups = await BridgeGroup.findAll({ where: { id: { [Op.in]: groupIds } }, raw: true });
    const guildMaps = await GuildMap.findAll({ where: { guildId: message.guildId } });
    if (guildMaps.some(g => g.get("inviteEnabled") === false)) {
      await message.reply("The invite command is disabled in this guild.");
      return;
    }

    const members = await BridgeEndpoint.findAll({
      where: { groupId: { [Op.in]: groupIds } },
      raw: true,
    });
    const target = members.find(x => x.platform !== sourcePlatform);
    if (!target) {
      await message.reply("This channel isn't part of a bridge.");
      return;
    }

    if (sourcePlatform === "fluxer") {
      let guild;
      try {
        guild = await discordClient.guilds.fetch(target.guildId);
      } catch {
        guild = null;
      }

      if (guild) {
        let guildInvite = "https://discord.gg/";
        if (guild.vanityURLCode) guildInvite += guild.vanityURLCode;
        else {
          const invite = await guild.invites.create(target.channelId, {
            maxAge: 172800,
          });
          guildInvite += invite.code;
        }

        await message.reply(
          `Invite code for **${guild.name}**${guild.vanityURLCode ? "" : " (valid for 2 days)"}: ${guildInvite}`
        );
      }
    } else {
      let guild;
      try {
        guild = await resolveFluxerClient(target.instanceId).guilds.fetch(target.guildId);
      } catch {
        guild = null;
      }

      if (guild) {
        const inviteBase = await getFluxerInviteBaseUrl(target.instanceId);
        let guildInvite = inviteBase + "/";
        if (guild.vanityURLCode) guildInvite += guild.vanityURLCode;
        else {
          /** @type {import("@fluxerjs/core").GuildChannel | null} */
          let channel;
          try {
            channel = await resolveFluxerClient(target.instanceId).channels.fetch(target.channelId);
          } catch {
            channel = null;
          }
          if (!channel) {
            await message.reply("Bridged Fluxer channel not found.");
            return;
          }
          const invite = await channel.createInvite({
            maxAge: 172800,
          });
          guildInvite += invite.code;
        }

        await message.reply(
          `Invite code for **${guild.name}**${guild.vanityURLCode ? "" : " (valid for 2 days)"}: ${guildInvite}`
        );
      }
    }
  },
};

export default command;
