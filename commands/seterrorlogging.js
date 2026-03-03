import { Channel as FluxerChannel } from "@fluxerjs/core";
import Config from "../utils/ConfigHandler.js";
import { ChannelMap, GuildMap } from "../db/index.js";
import { Op } from "sequelize";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s", "community", "c"],
  name: "seterrorlogging",
  aliases: ["errlog", "err"],
  description: "Set error logging channel",
  requireElevated: true,
  params: "<channelId>",
  additionalInfo:
    "Can take either a Discord channel or a Fluxer channel depends on where you ran it (if you run it on Discord, it needs a Discord channel ID)",
  async run(params, message, _, _2) {
    if (!params[0]) {
      await message.reply(
        `Missing parameters. Usage: \`${Config.BotPrefix}guild seterrorlogging <channelId>\``,
      );
      return;
    }

    const guildMap = await GuildMap.findOne({
      where: {
        guildId: message.guildId,
      },
    });

    if (!guildMap) {
      await message.reply("This channel needs to be bridged first.");
      return;
    }

    const channelId = params[0];

    const channel = await message.client.channels.fetch(channelId);
    if (channel instanceof FluxerChannel) {
      if (!channel.canSendMessage()) {
        await message.reply("The bot cannot send messages on this channel.");
        return;
      }
      guildMap.errorLoggingChannelId = channel.id;
      guildMap.errorLoggingPlatform = "fluxer";
    } else if (channel) {
      if (!channel.isSendable()) {
        await message.reply("The bot cannot send messages on this channel.");
        return;
      }
      guildMap.errorLoggingChannelId = channel.id;
      guildMap.errorLoggingPlatform = "discord";
    } else {
      await message.reply("The bot cannot find this channel.");
      return;
    }

    await guildMap.save();
    await message.reply("Done!");
  },
};

export default command;
