import { ChannelMap, sequelize } from "../db/index.js";
import DefaultConfig from "./ConfigHandler.js";

/**
 * @param {import("@fluxerjs/core").Client} fluxerClient
 * @param {import("discord.js").Client} discordClient
 */
export default async function changeBotBios(fluxerClient, discordClient) {
  const discordCounts = await ChannelMap.findAll({
    attributes: [
      "discordGuildId",
      [sequelize.fn("COUNT", sequelize.col("id")), "count"],
    ],
    group: ["discordGuildId"],
    raw: true,
  });

  for (const discordGuild of discordCounts) {
    try {
      const guild = await discordClient.guilds.fetch(
        discordGuild.discordGuildId,
      );
      await guild.members.editMe({
        bio:
          (DefaultConfig.DiscordBioStart
            ? DefaultConfig.DiscordBioStart + "\n\n"
            : "") +
          `Currently bridging ${discordGuild.count} channel${discordGuild.count != 1 ? "s" : ""} of this server to Fluxer\n\n` +
          "Docs: https://fluxcord.jbcrn.dev/",
      });
    } catch (e) {
      console.error(e);
    }
  }

  const fluxerCounts = await ChannelMap.findAll({
    attributes: [
      "fluxerGuildId",
      [sequelize.fn("COUNT", sequelize.col("id")), "count"],
    ],
    group: ["fluxerGuildId"],
    raw: true,
  });

  for (const fluxerGuild of fluxerCounts) {
    try {
      const guild = await fluxerClient.guilds.fetch(fluxerGuild.fluxerGuildId);
      await guild.members.me.edit({
        bio:
          (DefaultConfig.FluxerBioStart
            ? DefaultConfig.FluxerBioStart + "\n\n"
            : "") +
          `Currently bridging ${fluxerGuild.count} channel${fluxerGuild.count != 1 ? "s" : ""} of this community to Discord\n\n` +
          "[Docs](https://fluxcord.jbcrn.dev/) // [Support](https://fluxer.gg/jbcrn)",
      });
    } catch (e) {
      console.error(e);
    }
  }
}
