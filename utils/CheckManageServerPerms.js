import { PermissionFlagsBits } from "discord.js";
import { Client, PermissionFlags } from "@fluxerjs/core";
import DefaultConfig from "./ConfigHandler.js";

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {import('@fluxerjs/core').Client | import('discord.js').Client} client
 */
export async function checkManageServerPerms(guildId, userId, client) {
  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch {
    return false;
  }
  if (!guild) return false;

  if (DefaultConfig.AdminAccountIds.includes(userId)) return true;

  let member;
  try {
    member = client instanceof Client ? await guild.fetchMember(userId) : await guild.members.fetch(userId);
  } catch {
    return false;
  }

  if (!member) return false;

  return member.permissions.has(client instanceof Client ? PermissionFlags.ManageGuild : PermissionFlagsBits.ManageGuild);
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {import('@fluxerjs/core').Client | import('discord.js').Client} client
 */
export async function checkPingPerms(guildId, userId, client) {
  if (!userId) return;

  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch {
    return false;
  }
  if (!guild) return false;

  let member;
  try {
    member = client instanceof Client ? await guild.fetchMember(userId) : await guild.members.fetch(userId);
  } catch {
    return false;
  }

  if (!member) return false;

  return member.permissions.has(client instanceof Client ? PermissionFlags.MentionEveryone : PermissionFlagsBits.MentionEveryone);
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} userId
 * @param {import('@fluxerjs/core').Client | import('discord.js').Client} client
 */
export async function checkEmbedPerms(guildId, channelId, userId, client) {
  if (!userId) return;

  if (client instanceof Client) {
    let member;
    let channel;
    try {
      const guild = await client.guilds.fetch(guildId);
      member = await guild.fetchMember(userId);
      channel = await client.channels.fetch(channelId);
    } catch {
      return false;
    }

    try {
      if (channel?.isThread()) channel = await client.channels.fetch(channel.parentId ?? channelId);
      return Boolean(
        member?.permissionsIn(/** @type {import("@fluxerjs/core").GuildChannel} */ (channel)).has(PermissionFlags.EmbedLinks)
      );
    } catch {
      return false;
    }
  }

  let member;
  let channel;
  try {
    const guild = await client.guilds.fetch(guildId);
    member = await guild.members.fetch(userId);
    channel = await client.channels.fetch(channelId);
  } catch {
    return false;
  }

  try {
    return Boolean(
      member?.permissionsIn(/** @type {import("discord.js").GuildChannelResolvable} */ (channel)).has(
        PermissionFlagsBits.EmbedLinks
      )
    );
  } catch {
    return false;
  }
}
