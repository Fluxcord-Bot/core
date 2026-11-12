import { Message } from "@fluxerjs/core";
import { GuildMap } from "../../db/index.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["dbg", "debug"],
  name: "react",
  aliases: ["r"],
  description: "Reaction debug",
  requireElevated: false,
  excludeFromSlash: true,
  requireOwner: true,
  async run(params, msg, discordClient, fluxerClient) {
    let message = msg;
    if (msg.messageReference) {
      if (msg instanceof Message) {
        message = await msg.referencedMessage.fetch();
      } else {
        message = await msg.fetchReference();
      }
    }

    const guildMap = await GuildMap.findOne({
      where: {
        guildId: message.guildId,
      },
    });

    if (guildMap) {
      if (guildMap.errorReaction) {
        await message.react(guildMap.errorReaction);
      }
    } else {
      await message.react("⛓️‍💥");
    }

    await message.reply("done");
  },
};

export default command;
