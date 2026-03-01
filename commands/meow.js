import { EmbedBuilder } from "@fluxerjs/core";
import Config from "../config.js";
import { ChannelMap } from "../db/index.js";
import Package from "../package.json" with { type: "json" };

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */

const meow = ["mreow", "mrrp", "meow"]

const command = {
  name: "meow",
  description: ":3",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    message.reply(meow[Math.floor(math.random() * meow.length)]);
  },
};

export default command;
