import { EmbedBuilder } from "@fluxerjs/core";
import Config from "../utils/ConfigHandler.js";
import { getCommands } from "../utils/CommandHandler.js";
import { getGuildPrefix } from "../utils/GetGuildPrefix.js";
import { checkManageServerPerms } from "../utils/CheckManageServerPerms.js";

/**
 * @param {import('../utils/CommandSchema.d.ts').CommandSchema} cmd
 * @param {string} prefix
 */
function usage(cmd, prefix) {
  const grp = cmd.groupNames && cmd.groupNames.length > 0 ? cmd.groupNames[0] + " " : "";
  return `${prefix}${grp}${cmd.name}${cmd.params ? " " + cmd.params : ""}`;
}

/**
 * @param {import('../utils/CommandSchema.d.ts').CommandSchema} cmd
 * @param {string} prefix
 */
function genAliases(cmd, prefix) {
  const forms = [];
  if (cmd.groupNames && cmd.groupNames.length > 0) {
    forms.push(`\`${prefix}${cmd.groupNames[0]} ${cmd.name}\``);
    cmd.aliases?.forEach(x => forms.push(`\`${prefix}${cmd.groupNames[0]} ${x}\``));
    cmd.topLevelAliases?.forEach(x => forms.push(`\`${prefix}${x}\``));
  } else if (cmd.aliases && cmd.aliases.length > 0) {
    cmd.aliases.forEach(x => forms.push(`\`${prefix}${x}\``));
  }
  return forms.join(", ");
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
  slashOptions: [{ name: "command", type: "string", rest: true }],
  async run(params, message, _, _2) {
    const prefix = await getGuildPrefix(message.guildId ?? "");
    if (params[0]) {
      const command = (await getCommands()).find(
        x =>
          x.name === params[0] ||
          x.aliases?.includes(params[0]) ||
          x.topLevelAliases?.includes(params[0]) ||
          (x.groupNames?.includes(params[0]) && (x.name === params[1] || x.aliases?.includes(params[1])))
      );
      if (command && !command.hideFromHelp) {
        const aliases = genAliases(command, prefix);
        await message.reply({
          //@ts-expect-error
          embeds: [
            new EmbedBuilder()
              .setTitle(usage(command, prefix))
              .setDescription(
                (aliases ? `Aliases: ${aliases}\n` : "") +
                  command.description +
                  (command.additionalInfo ? `\n\n` + command.additionalInfo : "")
              )
              .setFooter(
                Config.EmbedFooterContent
                  ? {
                      text: Config.EmbedFooterContent,
                    }
                  : null
              ),
          ],
        });
      } else {
        await message.reply({
          content: `Cannot find command \`${params[0]}\`!`,
        });
      }
    } else {
      const isUserBotAdmin = Config.AdminAccountIds.find(x => x === message.author.id);
      const isUserGuildAdmin = await checkManageServerPerms(message.guildId ?? "", message.author.id, message.client);

      let cmds = (await getCommands()).filter(x => !x.hideFromHelp);

      if (!isUserBotAdmin) {
        cmds = cmds.filter(x => !x.requireOwner);
      }

      if (!isUserGuildAdmin) {
        cmds = cmds.filter(x => !x.requireElevated);
      }

      cmds = [...cmds].sort((a, b) => a.name.localeCompare(b.name));

      /** @type {Map<string, import('../utils/CommandSchema.d.ts').CommandSchema[]>} */
      const grouped = new Map();
      /** @type {import('../utils/CommandSchema.d.ts').CommandSchema[]} */
      const ungrouped = [];
      for (const cmd of cmds) {
        const grp = cmd.groupNames && cmd.groupNames.length > 0 ? cmd.groupNames[0] : undefined;
        if (grp) {
          if (!grouped.has(grp)) grouped.set(grp, []);
          grouped.get(grp).push(cmd);
        } else {
          ungrouped.push(cmd);
        }
      }

      /** @type {{ name: string, value: string, inline: boolean }[]} */
      const fields = [];
      for (const [grp, list] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        fields.push({
          name: `${prefix}${grp}`,
          value: list
            .map(x => {
              const bare = x.topLevelAliases && x.topLevelAliases.length > 0 ? ` (or \`${prefix}${x.topLevelAliases[0]}\`)` : "";
              return `\`${prefix}${grp} ${x.name}${x.params ? " " + x.params : ""}\`: ${x.description}${bare}`;
            })
            .join("\n"),
          inline: false,
        });
      }
      if (ungrouped.length > 0) {
        fields.push({
          name: "general",
          value: ungrouped.map(x => `\`${prefix}${x.name}${x.params ? " " + x.params : ""}\`: ${x.description}`).join("\n"),
          inline: false,
        });
      }

      await message.reply({
        //@ts-expect-error
        embeds: [
          new EmbedBuilder()
            .setTitle("Fluxcord")
            .setDescription(
              `Fluxcord is a bridge that bridges a Discord channel and a Fluxer channel.\n\nPrefix is \`${prefix}\`. To be able to configure the bot's bridging features, you will need the Manage Server/Community permission.`
            )
            .addFields(...fields)
            .setFooter(
              Config.EmbedFooterContent
                ? {
                    text: Config.EmbedFooterContent,
                  }
                : null
            ),
        ],
      });
    }
  },
};

export default command;
