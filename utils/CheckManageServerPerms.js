import { PermissionFlagsBits } from "discord.js";
import { Client, PermissionFlags } from "@fluxerjs/core";
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

  const member = await guild.members.fetch((client instanceof Client) ? { id: userId } : userId);

  if (!member) return false;

  if (Array.isArray(member)) {
    const target = member[0]
    if (!target) return false;
    return (
      target.permissions.has(PermissionFlags.ManageGuild) ||
      target.permissions.has(PermissionFlags.Administrator)
    );
  }

  return (
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlags.ManageGuild)
  );
}