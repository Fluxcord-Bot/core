import { GuildChannel as DiscordGuildChannel } from "discord.js";
import {
  Message as FluxerMessage,
  GuildChannel as FluxerGuildChannel,
} from "@fluxerjs/core";
import { ChannelMap, GuildMap } from "../db/index.js";
import { log } from "../utils/Logger.js";
import { BridgeMap } from "../utils/CommandHandler.js";
import { Op } from "sequelize";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "invite",
  description: "Get an invite code from the other side",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: {
          discordChannelId: message.channelId,
          fluxerChannelId: message.channelId,
          discordGuildId: message.guildId,
          fluxerGuildId: message.guildId,
        },
      },
    });

    if (!channelMap) {
      await message.reply("This channel isn't part of a bridge.");
      return;
    }

    if (message instanceof FluxerMessage) {
      const guild = await discordClient.guilds.fetch(channelMap.discordGuildId);

      if (guild) {
        let guildInvite = "https://discord.gg/";
        if (guild.vanityURLCode) guildInvite += guild.vanityURLCode;
        else {
          const invite = await guild.invites.create(
            channelMap.discordChannelId,
            {
              maxAge: 172800,
            },
          );
          guildInvite += invite.code;
        }

        await message.reply(
          `Invite code for **${guild.name}**${guild.vanityURLCode ? "" : " (valid for 2 days)"}: ${guildInvite}`,
        );
      }
    } else {
      const guild = await fluxerClient.guilds.fetch(channelMap.fluxerGuildId);

      if (guild) {
        let guildInvite = "https://fluxer.gg/";
        if (guild.vanityURLCode) guildInvite += guild.vanityURLCode;
        else {
          /** @type {import("@fluxerjs/core").GuildChannel} */
          const channel = await fluxerClient.channels.fetch(
            channelMap.fluxerChannelId,
          );
          const invite = await channel.createInvite({
            max_age: 172800,
          });
          guildInvite += invite.code;
        }

        await message.reply(
          `Invite code for **${guild.name}**${guild.vanityURLCode ? "" : " (valid for 2 days)"}: ${guildInvite}`,
        );
      }
    }
  },
};

export default command;
