import { EmbedBuilder, Routes as FluxerRoutes, Message } from "@fluxerjs/core";
import { Routes } from "discord.js";

/**
 * @type {import('../utils/CommandSchema.js').CommandSchema}
 */
const command = {
  name: "ping",
  description: "...pong?",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    const isFluxer = message instanceof Message;
    const messageStart = Date.now();
    const msg = await message.reply("Pinging...");
    const messageLatency = Date.now() - messageStart;
    const fluxerRestStart = Date.now();
    await fluxerClient.rest.get(FluxerRoutes.currentUser());
    const fluxerRestLatency = Date.now() - fluxerRestStart;
    const discordRestStart = Date.now();
    await discordClient.rest.get(Routes.currentApplication());
    const discordRestLatency = Date.now() - discordRestStart;
    await msg.edit({
      content: "",
      //@ts-expect-error
      embeds: [
        new EmbedBuilder().setTitle("Ping").addFields(
          {
            name: (isFluxer ? "Fluxer" : "Discord") + " Message round-trip",
            value: `${messageLatency}ms`,
            inline: true,
          },
          {
            name: "Fluxer REST",
            value: `${fluxerRestLatency}ms`,
            inline: true,
          },
          {
            name: "Discord REST",
            value: `${discordRestLatency}ms`,
            inline: true,
          },
        ),
      ],
    });
  },
};

export default command;
