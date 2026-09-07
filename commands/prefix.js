import { Message } from "@fluxerjs/core";
import { GuildMap } from "../db/index.js";
import Config from "../utils/ConfigHandler.js";

const MAX_PREFIX_LENGTH = 10;

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s", "community", "c"],
  name: "prefix",
  description:
    "View or change this server's command prefix. Once a custom prefix is set, the bot will only respond to that prefix here.",
  aliases: ["setprefix"],
  params: "[newPrefix|reset]",
  requireElevated: true,
  async run(params, message, _, _2) {
    const guildMap = await GuildMap.findOrCreate({
      where: {
        guildId: message.guildId,
      },
      defaults: {
        guildType: message instanceof Message ? "fluxer" : "discord",
      },
    });

    const currentPrefix = guildMap[0].botPrefix || Config.BotPrefix;

    if (!params[0]) {
      await message.reply(
        `The prefix for this server is \`${currentPrefix}\`. Run \`${currentPrefix}prefix <newPrefix>\` to change it, or \`${currentPrefix}prefix reset\` to go back to the default (\`${Config.BotPrefix}\`).`,
      );
      return;
    }

    if (params[0].toLowerCase() === "reset") {
      guildMap[0].botPrefix = Config.BotPrefix;
      await guildMap[0].save();
      await message.reply(
        `Prefix reset! The bot will now respond to \`${Config.BotPrefix}\` in this server.`,
      );
      return;
    }

    const newPrefix = params[0].trim();

    if (!newPrefix) {
      await message.reply("The prefix cannot be empty.");
      return;
    }

    if (newPrefix.length > MAX_PREFIX_LENGTH) {
      await message.reply(
        `The prefix cannot be longer than ${MAX_PREFIX_LENGTH} characters.`,
      );
      return;
    }

    guildMap[0].botPrefix = newPrefix;
    await guildMap[0].save();

    await message.reply(
      `Prefix changed! The bot will now only respond to \`${newPrefix}\` in this server (no longer to \`${Config.BotPrefix}\`).`,
    );
  },
};

export default command;
