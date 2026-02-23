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
  async run(params, message, discordClient, fluxerClient) {
    const allBridgedChannels = await ChannelMap.findAll();
    const mappedChannels = await Promise.all(
      allBridgedChannels.map(async (x) => {
        try {
          let discordGuild: DiscordGuild | undefined = undefined,
            discordChannel: DiscordGuildChannel | undefined = undefined,
            fluxerGuild: Guild | null = null,
            fluxerChannel: FluxerChannel | null = null;
          try {
            discordGuild = await discordClient.guilds.fetch(x.discordGuildId);
          } catch {}
          try {
            discordChannel = (await discordClient.channels.fetch(
              x.discordChannelId,
            )) as DiscordGuildChannel;
          } catch {}
          try {
            fluxerChannel = await fluxerClient.channels.fetch(
              x.discordChannelId,
            );
          } catch {}
          try {
            fluxerGuild = await fluxerClient.guilds.fetch(x.fluxerGuildId);
          } catch {}
          return {
            ...x,
            discordChannel,
            discordGuild,
            fluxerChannel,
            fluxerGuild,
          };
        } catch (e) {
          log("DEBUG", e);
          return x;
        }
      }),
    );

    const str = mappedChannels
      .map(
        (x) =>
          //@ts-expect-error
          `${x.fluxerChannel?.name} (${x.fluxerChannelId}) on ${x.fluxerGuild?.name} (${x.fluxerGuildId}) ${
            x.bridgeType === "both"
              ? "<->"
              : x.bridgeType === "fluxer2discord"
                ? "-->"
                : "<--"
            //@ts-expect-error
          } ${x.discordGuild?.name} (${x.discordChannelId}) on ${x.discordGuild?.name} (${x.discordGuildId})`,
      )
      .join("\n");

    const strBuf = Buffer.from(str);

    if (message instanceof FluxerMessage) {
      await message.reply({
        files: [{ name: "channels.txt", data: strBuf }],
      });
    } else {
      const att = new AttachmentBuilder(strBuf).setName("channels.txt");

      await message.reply({
        files: [att],
      });
    }
  },
};

export default command;
