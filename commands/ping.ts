import { Message, EmbedBuilder } from "@fluxerjs/core";
import Config from "../config";
import type { CommandSchema } from "../utils/CommandSchema";
import { commands } from "../utils/CommandHandler";
import { getDuration } from "../utils/GetDuration";
import { botStartingTime } from "..";

const command: CommandSchema = {
  name: "uptime",
  description: "Bot uptime",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    const fluxcordUptime = getDuration(botStartingTime, new Date());
    const fluxerBotUptime = getDuration(
      fluxerClient.readyAt ?? new Date(),
      new Date(),
    );
    const discordBotUptime = getDuration(
      discordClient.readyAt ?? new Date(),
      new Date(),
    );
    await message.reply({
      //@ts-expect-error
      embeds: [
        new EmbedBuilder().setTitle("Uptime").addFields(
          {
            name: "Fluxcord itself",
            value: fluxcordUptime,
            inline: true,
          },
          {
            name: "Fluxer bot",
            value: fluxerBotUptime,
            inline: true,
          },
          {
            name: "Discord bot",
            value: discordBotUptime,
            inline: true,
          },
        ),
      ],
    });
  },
};

export default command;
