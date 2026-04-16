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

  const member = (client instanceof Client) ? await guild.fetchMember(userId) : await guild.members.fetch(userId);

  if (!member) return false;

  console.log(member.permissions)

  return (
    member.permissions.has((client instanceof Client) ? PermissionFlags.ManageGuild : PermissionFlagsBits.ManageGuild)
  );
}