import { PermissionFlagsBits } from "discord.js";
import { PermissionFlags } from "@fluxerjs/core";
import DefaultConfig from "./ConfigHandler.js";

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {import('@fluxerjs/core').Client | import('discord.js').Client} client
 */
export async function checkManageServerPerms(guildId, userId, client) {
  const guild = await client.guilds.fetch(guildId);
  if (!guild) return false;

  if (DefaultConfig.AdminAccountIds.includes(userId)) return true;

  const member = await guild.members.fetch(userId);
  if (!member) return false;

  if (Array.isArray(member)) {
    const target = member.find((m) => m.user?.id === userId || m.id === userId);
    if (!target) return false;
    return (
      target.permissions.has(PermissionFlagsBits.ManageGuild) ||
      target.permissions.has(PermissionFlags.ManageGuild)
    );
  }

  return (
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlags.ManageGuild)
  );
}