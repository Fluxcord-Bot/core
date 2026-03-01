import { EmbedBuilder } from "@fluxerjs/core";
import { getDuration } from "../utils/GetDuration.js";
import { botStartingTime } from "../index.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
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
