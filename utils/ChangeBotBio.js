import { Guild } from "@fluxerjs/core";
import { GuildMap } from "../db/index.js";
import DefaultConfig from "./ConfigHandler.js";

/**
 * @param {import("@fluxerjs/core").Guild | import("discord.js").Guild} guild
 */
export default async function changeBotBio(guild) {
  try {
    const guildMap = await GuildMap.findOne({
      where: { guildId: guild.id },
    });
    if (guildMap?.customBio) {
      if (guild instanceof Guild) {
        await guild.members.me.edit({ bio: guildMap.customBio });
      } else {
        await guild.members.editMe({ bio: guildMap.customBio });
      }
      return;
    }
  } catch (e) {
    console.error(e);
  }
  if (guild instanceof Guild) {
    try {
      await guild.members.me.edit({
        bio:
          (DefaultConfig.FluxerBioStart ? DefaultConfig.FluxerBioStart + "\n\n" : "") +
          `Currently bridging ${guild.channels.size} channel${guild.channels.size != 1 ? "s" : ""} of this community to Discord\n\n` +
          "[Docs](https://fluxcord.jbcrn.dev/) // [Support](https://fluxer.gg/jbcrn)",
      });
    } catch (e) {
      console.error(e);
    }
  } else {
    try {
      await guild.members.editMe({
        bio:
          (DefaultConfig.DiscordBioStart ? DefaultConfig.DiscordBioStart + "\n\n" : "") +
          `Currently bridging ${guild.channels.size} channel${guild.channels.size != 1 ? "s" : ""} of this server to Fluxer\n\n` +
          "Docs: https://fluxcord.jbcrn.dev/",
      });
    } catch (e) {
      console.error(e);
    }
  }
}
