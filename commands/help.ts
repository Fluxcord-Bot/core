import { Message, EmbedBuilder } from "@fluxerjs/core";
import Config from "../config";
import type { CommandSchema } from "../utils/CommandSchema";
import { commands } from "../utils/CommandHandler";

const command: CommandSchema = {
  name: "help",
  description: "Help for Fluxbot's functions",
  requireElevated: false,
  async run(params, message, _, _2) {
    await message.reply({
      //@ts-expect-error
      embeds: [
        new EmbedBuilder()
          .setTitle("Fluxcord")
          .setDescription(
            `Fluxcord is a bridge that bridges a Discord channel and a Fluxer channel.

Prefix is \`${Config.BotPrefix}\`. To use the bot's bridging features, you will need the Manage Server/Community permission.`,
          )
          .addFields(
            ...commands.map((x) => ({
              name: `${Config.BotPrefix}${x.name}`,
              value: x.description,
              inline: true,
            })),
          ),
      ],
    });
  },
};

export default command;
