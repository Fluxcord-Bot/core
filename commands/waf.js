import { EmbedBuilder } from "@fluxerjs/core";
import Config from "../config.js";
import { ChannelMap } from "../db/index.js";
import Package from "../package.json" with { type: "json" };

/**
 * @type {import('../utils/CommandSchema.js').CommandSchema}
 */

const waf = ["waf", "arf", "waff", "awaf"];

const command = {
  name: "waf",
  description: ":3",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    message.reply(waf[Math.floor(Math.random() * waf.length)]);
  },
};

export default command;
