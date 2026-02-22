import { Client as DiscordClient, PermissionFlagsBits } from "discord.js";
import { Client as FluxerClient, PermissionFlags } from "@fluxerjs/core";

export async function checkManageServerPerms(
  guildId: string,
  userId: string,
  client: FluxerClient | DiscordClient,
) {
  const guild = await client.guilds.fetch(guildId);
  if (!guild) return false;
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
