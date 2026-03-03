import { Channel as FluxerChannel } from "@fluxerjs/core";
import Config from "../utils/ConfigHandler.js";
import { ChannelMap, GuildMap } from "../db/index.js";
import { Op } from "sequelize";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["admin", "a"],
  name: "restart",
  aliases: ["r"],
  description: "Restart bot",
  requireElevated: false,
  requireOwner: true,
  async run(params, message, _, _2) {
    await message.reply("Restarting...");

    process.exit(67);
  },
};

export default command;
