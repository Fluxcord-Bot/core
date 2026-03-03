import { PermissionFlagsBits } from "discord.js";
import { PermissionFlags } from "@fluxerjs/core";
import DefaultConfig from "./ConfigHandler.js";

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {FluxerClient | DiscordClient} client
 */
export async function checkManageServerPerms(guildId, userId, client) {
  const guild = await client.guilds.fetch(guildId);
  if (!guild) return false;
  if (DefaultConfig.AdminAccountIds.find((x) => x === userId)) return true;
  const user = await guild.members.fetch({
    user: userId,
  });
  if (Array.isArray(user)) {
    return (
      user[0]?.permissions.has(PermissionFlags.ManageGuild) ||
      user[0]?.permissions.has(PermissionFlags.Administrator) ||
      guild.ownerId == userId
    );
  } else {
    return (
      user.permissions.has(PermissionFlagsBits.ManageGuild) ||
      user.permissions.has(PermissionFlagsBits.Administrator) ||
      guild.ownerId == user.id
    );
  }
}
