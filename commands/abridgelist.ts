import { Message, EmbedBuilder, GuildChannel, Guild } from "@fluxerjs/core";
import Config from "../config";
import type { CommandSchema } from "../utils/CommandSchema";
import { BridgeMap, commands } from "../utils/CommandHandler";

import {
  AttachmentBuilder,
  GuildChannel as DiscordGuildChannel,
  Guild as DiscordGuild,
} from "discord.js";
import {
  Message as FluxerMessage,
  Channel as FluxerChannel,
} from "@fluxerjs/core";
import { ChannelMap } from "../db";
import { Op } from "sequelize";
import { log } from "../utils/Logger";

const command: CommandSchema = {
  name: "abridgelist",
  description: "Total bridge list",
  requireElevated: false,
  requireOwner: true,
  async run(_, message, discordClient, fluxerClient) {
    const allBridgedChannels = await ChannelMap.findAll();

    const mappedChannels = await Promise.all(
      allBridgedChannels.map(async (x) => {
        const data = x.dataValues;

        const [discordGuild, discordChannel, fluxerChannel, fluxerGuild] =
          await Promise.allSettled([
            discordClient.guilds.fetch(data.discordGuildId),
            discordClient.channels.fetch(data.discordChannelId),
            fluxerClient.channels.fetch(data.fluxerChannelId),
            fluxerClient.guilds.fetch(data.fluxerGuildId),
          ]);

        return {
          ...data,
          discordGuild:
            discordGuild.status === "fulfilled"
              ? (discordGuild.value as DiscordGuild)
              : undefined,
          discordChannel:
            discordChannel.status === "fulfilled"
              ? (discordChannel.value as DiscordGuildChannel)
              : undefined,
          fluxerChannel:
            fluxerChannel.status === "fulfilled"
              ? (fluxerChannel.value as FluxerChannel)
              : null,
          fluxerGuild:
            fluxerGuild.status === "fulfilled"
              ? (fluxerGuild.value as Guild)
              : null,
        };
      }),
    );

    const bridgeArrow = (type: string) =>
      type === "both" ? "<->" : type === "fluxer2discord" ? "-->" : "<--";

    const str = mappedChannels
      .map(
        (x) =>
          `${x.fluxerChannel?.name ?? "unknown"} (${x.fluxerChannelId}) on ${x.fluxerGuild?.name ?? "unknown"} (${x.fluxerGuildId}) ` +
          `${bridgeArrow(x.bridgeType)} ` +
          `${x.discordChannel?.name ?? "unknown"} (${x.discordChannelId}) on ${x.discordGuild?.name ?? "unknown"} (${x.discordGuildId})`,
      )
      .join("\n");

    const strBuf = Buffer.from(str);

    if (message instanceof FluxerMessage) {
      await message.reply({ files: [{ name: "channels.txt", data: strBuf }] });
    } else {
      await message.reply({
        files: [new AttachmentBuilder(strBuf).setName("channels.txt")],
      });
    }
  },
};

export default command;
