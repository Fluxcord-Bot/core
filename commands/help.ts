import { Message, EmbedBuilder } from "@fluxerjs/core";
import Config from "../config";
import type { CommandSchema } from "../utils/CommandSchema";
import { commands } from "../utils/CommandHandler";
import { checkManageServerPerms } from "../utils/CheckManageServerPerms";

const command: CommandSchema = {
  name: "help",
  description: "Help for Fluxbot's functions",
  requireElevated: false,
  params: "[command]",
  async run(params, message, _, _2) {
    if (params[0]) {
      const command = commands.find((x) => x.name === params[0]);
      if (command) {
        await message.reply({
          //@ts-expect-error
          embeds: [
            new EmbedBuilder()
              .setTitle(
                `${Config.BotPrefix}${command.name}${command.params ? " " + command.params : ""}`,
              )
              .setDescription(
                command.description +
                  (command.additionalInfo
                    ? `\n\n` + command.additionalInfo
                    : ""),
              )
              .setFooter(
                Config.EmbedFooterContent
                  ? {
                      text: Config.EmbedFooterContent,
                    }
                  : null,
              ),
          ],
        });
      } else {
        await message.reply({
          content: `Cannot find command \`${params[0]}\`!`,
        });
      }
    } else {
      const isUserBotAdmin = Config.AdminAccountIds.find(
        (x) => x === message.author.id,
      );
      const isUserGuildAdmin = checkManageServerPerms(
        message.guildId ?? "",
        message.author.id,
        message.client,
      );

      let cmds = commands;

      if (!isUserBotAdmin) {
        cmds = cmds.filter((x) => !x.requireOwner);
      }

      if (!isUserGuildAdmin) {
        cmds = cmds.filter((x) => !x.requireElevated);
      }

      await message.reply({
        //@ts-expect-error
        embeds: [
          new EmbedBuilder()
            .setTitle("Fluxcord")
            .setDescription(
              `Fluxcord is a bridge that bridges a Discord channel and a Fluxer channel.

Prefix is \`${Config.BotPrefix}\`. To be able to configure the bot's bridging features, you will need the Manage Server/Community permission.`,
            )
            .addFields(
              ...cmds.map((x) => ({
                name: `${Config.BotPrefix}${x.name}${x.params ? " " + x.params : ""}`,
                value: x.description,
                inline: true,
              })),
            )
            .setFooter(
              Config.EmbedFooterContent
                ? {
                    text: Config.EmbedFooterContent,
                  }
                : null,
            ),
        ],
      });
    }
  },
};

export default command;
