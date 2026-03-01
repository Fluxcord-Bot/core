import { Channel as FluxerChannel } from "@fluxerjs/core";
import Config from "../utils/ConfigHandler.js";
import { ChannelMap } from "../db/index.js";
import { Op } from "sequelize";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "seterrorlogging",
  description: "Set error logging channel",
  requireElevated: true,
  params: "<channelId>",
  additionalInfo:
    "Can take either a Discord channel or a Fluxer channel depends on where you ran it (if you run it on Discord, it needs a Discord channel ID)",
  async run(params, message, _, _2) {
    if (!params[0]) {
      await message.reply(
        `Missing parameters. Usage: \`${Config.BotPrefix}seterrorlogging <channelId>\``,
      );
      return;
    }

    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: [
          {
            discordChannelId: message.channelId,
          },
          {
            fluxerChannelId: message.channelId,
          },
        ],
      },
    });

    if (!channelMap) {
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
      await /** @type {TextChannel} */ (channel).send({
        content: `This channel is configured as the channel where to send the errors on bridging <#${message.channelId}> into.`,
      });
      channelMap.errorLoggingChannelId = channel.id;
      channelMap.errorLoggingPlatform = "fluxer";
    } else if (channel) {
      if (!channel.isSendable()) {
        await message.reply("The bot cannot send messages on this channel.");
        return;
      }
      await channel.send({
        content: `This channel is configured as the channel where to send the errors on bridging <#${message.channelId}> into.`,
      });
      channelMap.errorLoggingChannelId = channel.id;
      channelMap.errorLoggingPlatform = "discord";
    } else {
      await message.reply("The bot cannot find this channel.");
      return;
    }

    await channelMap.save();
    await message.reply("Done!");
  },
};

export default command;
