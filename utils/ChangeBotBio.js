import { Guild } from "@fluxerjs/core";
import DefaultConfig from "./ConfigHandler.js";

/**
 * @param {import("@fluxerjs/core").Guild | import("discord.js").Guild} guild
 */
export default async function changeBotBio(guild) {
  if (guild instanceof Guild) {
    try {
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
  } else {
    try {
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
}
