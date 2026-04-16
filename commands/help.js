import { EmbedBuilder } from "@fluxerjs/core";
import Config from "../utils/ConfigHandler.js";
import { getCommands } from "../utils/CommandHandler.js";
import { checkManageServerPerms } from "../utils/CheckManageServerPerms.js";

/**
 *
 * @param {string} cmd
 * @param {string[]?} aliases
 * @param {string[]?} grp
 */
function genAliases(cmd, aliases, grp) {
  const cmds = [];
  if (grp && grp.length > 0) {
    grp.forEach((x) => {
      cmds.push(`\`${Config.BotPrefix}${x} ${cmd}\``);
      if (aliases && aliases.length > 0) {
        aliases.forEach((y) => cmds.push(`\`${Config.BotPrefix}${x} ${y}\``));
      }
    });
  } else if (aliases && aliases.length > 0) {
    aliases.forEach((x) => cmds.push(`\`${Config.BotPrefix}${x}\``));
  }
  return cmds.join(", ");
}

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "help",
  aliases: ["?"],
  description: "Help for Fluxcord's functions",
  requireElevated: false,
  params: "[...command]",
  async run(params, message, _, _2) {
    if (params[0]) {
      const command = (await getCommands()).find(
        (x) =>
          x.name === params[0] ||
          x.aliases?.includes(params[0]) ||
          (x.groupNames?.includes(params[0]) &&
            (x.name === params[1] || x.aliases?.includes(params[1]))),
      );
      if (command && !command.hideFromHelp) {
        const aliases = genAliases(
          command.name,
          command.aliases,
          command.groupNames,
        );
        await message.reply({
          //@ts-expect-error
          embeds: [
            new EmbedBuilder()
              .setTitle(
                `${Config.BotPrefix}${command.groupNames ? command.groupNames[0] + " " : ""}${command.name}${command.params ? " " + command.params : ""}`,
              )
              .setDescription(
                (aliases ? `Aliases: ${aliases}\n` : "") +
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
      const isUserGuildAdmin = await checkManageServerPerms(
        message.guildId ?? "",
        message.author.id,
        message.client,
      );

      console.log("guild admin?", isUserGuildAdmin)

      let cmds = (await getCommands()).filter((x) => !x.hideFromHelp);

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
              `Fluxcord is a bridge that bridges a Discord channel and a Fluxer channel.\n\nPrefix is \`${Config.BotPrefix}\`. To be able to configure the bot's bridging features, you will need the Manage Server/Community permission.`,
            )
            .addFields(
              ...cmds.map((x) => ({
                name: `${Config.BotPrefix}${x.groupNames ? x.groupNames[0] + " " : ""}${x.name}${x.params ? " " + x.params : ""}`,
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
