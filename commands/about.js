import { EmbedBuilder } from "@fluxerjs/core";
import Config from "../config.js";
import { ChannelMap } from "../db/index.js";
import Package from "../package.json" with { type: "json" };

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "about",
  description: "About Fluxcord",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    const channels = await ChannelMap.findAll();
    await message.reply({
      //@ts-expect-error
      embeds: [
        new EmbedBuilder()
          .setTitle("Fluxcord " + Package.version)
          .setThumbnail("https://party.jbc.lol/fluxcord.png")
          .setDescription(
            `Fluxcord is a simple, set-and-forget Discord <-> Fluxer bridge.

Currently bridging ${channels.length} channel${channels.length === 1 ? "" : "s"}`,
          )
          .addFields(
            {
              name: "Support community",
              value: "https://fluxer.gg/waf && https://discord.waf.moe",
              inline: true,
            },
            {
              name: "Source code",
              value: "https://git.gay/Fluxcord/core",
              inline: true,
            },
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
  },
};

export default command;
