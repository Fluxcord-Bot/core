import { genAuthLink } from "../utils/GenAuthLink.js";
import { fluxerClients, defaultFluxerClient } from "../utils/FluxerClients.js";
import Config, { DiscordEnabled } from "../utils/ConfigHandler.js";

async function safeAuthLink(clientId, fluxer, instanceId) {
  if (!clientId) return null;
  try {
    return await genAuthLink(clientId, fluxer, instanceId);
  } catch {
    return null;
  }
}

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "invitebot",
  aliases: ["botinvite"],
  description: "Get all of the bot's invite links",
  requireElevated: false,
  allowDM: true,
  async run(params, message, discordClient, fluxerClient) {
    const links = [];

    if (DiscordEnabled) {
      const clientId = discordClient?.user?.id ?? Config.DiscordClientId;
      const link = await safeAuthLink(clientId, false);
      if (link) links.push(`Discord:\n<${link}>`);
    }

    const defaultLink = await safeAuthLink(defaultFluxerClient?.user?.id, true, "default");
    if (defaultLink) links.push(`Fluxer:\n<${defaultLink}>`);

    for (const [instanceId, client] of fluxerClients) {
      if (instanceId === "default") continue;
      const link = await safeAuthLink(client?.user?.id, true, instanceId);
      if (link) links.push(`Fluxer (${instanceId}):\n<${link}>`);
    }

    if (links.length === 0) {
      await message.reply("No invite links are available right now.");
      return;
    }

    await message.reply(["Invite Fluxcord:", "", ...links].join("\n"));
  },
};

export default command;
