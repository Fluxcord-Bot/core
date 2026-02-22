import { Message, EmbedBuilder } from "@fluxerjs/core";
import Config from "../config";
import type { CommandSchema } from "../utils/CommandSchema";
import { BridgeMap, commands } from "../utils/CommandHandler";

import { GuildChannel as DiscordGuildChannel } from "discord.js";
import {
  Message as FluxerMessage,
  Channel as FluxerChannel,
} from "@fluxerjs/core";
import { ChannelMap } from "../db";
import { Op } from "sequelize";

const command: CommandSchema = {
  name: "bridge",
  description: "Bridge a channel",
  requireElevated: true,
  async run(params, message, discordClient, fluxerClient) {
    let isFluxer = message instanceof FluxerMessage;
    const channelId = params[0];
    const typeDef = params[1];

    if (!channelId || !typeDef) {
      await message.reply(`Missing parameters. Usage:
\`\`\`
${Config.BotPrefix}bridge [CHANNEL_ID] [TYPE]
\`\`\``);
      return;
    }

    const type = typeDef.toUpperCase() as
      | "DISCORD2FLUXER"
      | "FLUXER2DISCORD"
      | "BOTH";

    const channel = await (
      isFluxer ? discordClient : fluxerClient
    ).channels.fetch(channelId);

    if (!channel) {
      await message.reply("Channel not found. Maybe invite the bot?");
      return;
    } else if (
      channel instanceof FluxerChannel &&
      (!channel.isSendable() || channel.isDM())
    ) {
      await message.reply(
        "Channel type is not a text-based channel or is a DM.",
      );
      return;
    } else if (
      !(channel instanceof FluxerChannel) &&
      (!channel.isSendable() || channel.isDMBased() || !channel.isTextBased())
    ) {
      await message.reply(
        "Channel type is not a text-based channel or is a DM.",
      );
      return;
    }

    const channelMap = await ChannelMap.findOne({
      where: {
        [Op.or]: [
          {
            fluxerChannelId: channelId,
          },
          {
            discordChannelId: channelId,
          },
          {
            fluxerChannelId: message.channelId,
          },
          {
            discordChannelId: message.channelId,
          },
        ],
      },
    });

    if (channelMap || BridgeMap.has(channelId)) {
      await message.reply(
        "This channel is already bridged. Run `" +
          Config.BotPrefix +
          "unbridge` to unbridge, then configure it again.",
      );
      return;
    }

    BridgeMap.set(channelId, {
      discordChannel: isFluxer ? channelId : message.channelId,
      fluxerChannel: isFluxer ? message.channelId : channelId,
      bridgeType: type,
    });

    message.reply(
      `Now, verify if you wanna bridge on the other end by using \`${Config.BotPrefix}verify\`! You have 2 minutes to do it or else it will expire.`,
    );

    channel.send({
      content: `${isFluxer ? "Fluxer" : "Discord"} channel ${
        message.channel instanceof FluxerChannel
          ? message.channel.name
          : message.channel instanceof DiscordGuildChannel
            ? message.channel.name
            : ""
      } on ${isFluxer ? "community" : "server"} ${message.guild?.name} wants to bridge to this channel.

To approve the bridge, run \`${Config.BotPrefix}verify\`! If not, just ignore this message and it will be cancelled after 2 minutes.`,
    });
  },
};

export default command;
