import { Message } from "@fluxerjs/core";
import { GuildMap, UserConfig } from "../db/index.js";
import { log } from "node:console";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s", "community", "c"],
  name: "seterrorreaction",
  description: "Set bot error emoji reaction, do not specify any to disable",
  aliases: ["setreact", "setemoji", "se"],
  params: "<emoji>",
  requireElevated: true,
  async run(params, message, discordClient, fluxerClient) {
    if (params[0] && params[0].startsWith("<")) {
      try {
        if (message instanceof Message) {
          await fluxerClient.resolveEmoji(
            params[0].replace("<", "").replace(">", ""),
            message.guildId,
          );
        } else {
          await message.guild.emojis.fetch(
            params[0].replace("<", "").replace(">", "").split(":")[2],
          );
        }
      } catch (e) {
        log("DEBUG", e);
        message.reply("Specified custom emoji should be on this server.");
        return;
      }
    }

    const guildMap = await GuildMap.findOrCreate({
      where: {
        guildId: message.guildId,
      },
      defaults: {
        guildType: message instanceof Message ? "fluxer" : "discord",
      },
    });

    guildMap[0].errorReaction = params[0] ?? null;
    await guildMap[0].save();

    if (params[0]) {
      message.reply(
        `Successfully set ${guildMap[0].errorReaction} as error reaction!`,
      );
    } else {
      message.reply(`Successfully disabled error reaction!`);
    }
  },
};

export default command;
