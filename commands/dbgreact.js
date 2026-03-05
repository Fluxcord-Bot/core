import { GuildMap } from "../db/index.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["dbg", "debug"],
  name: "react",
  aliases: ["r"],
  description: "Reaction debug",
  requireElevated: false,
  requireOwner: true,
  async run(params, message, discordClient, fluxerClient) {
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
