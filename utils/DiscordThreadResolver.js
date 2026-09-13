/**
 * @param {import('discord.js').Client} discordClient
 * @param {any} channel
 */
export async function resolveDiscordParentChannel(discordClient, channel) {
  if (!channel || typeof channel.isThread !== "function") return channel;
  if (!channel.isThread()) return channel;

  try {
    return await discordClient.channels.fetch(channel.parentId);
  } catch {
    return null;
  }
}

/**
 * @param {import('discord.js').Client} discordClient
 * @param {string} discordChannelId
 */
export async function resolveDiscordThreadId(discordClient, discordChannelId) {
  let channel;
  try {
    channel = await discordClient.channels.fetch(discordChannelId);
  } catch {
    return null;
  }

  if (!channel || !channel.isThread()) return null;
  return channel.id;
}
