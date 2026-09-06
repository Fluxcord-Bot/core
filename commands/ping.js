import { EmbedBuilder, Routes as FluxerRoutes, Message } from "@fluxerjs/core";
import { Routes } from "discord.js";
import { ChannelMap, MessageMap } from "../db/index.js";
import { getDuration } from "../utils/GetDuration.js";
import { botStartingTime } from "../index.js";
import Config from "../utils/ConfigHandler.js";

/**
 * @type {import('../utils/CommandSchema.js').CommandSchema}
 */
const command = {
  name: "ping",
  description: "...pong? (bot latency and stats)",
  aliases: ["stats"],
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    const isFluxer = message instanceof Message;
    const now = new Date();
    const messageStart = Date.now();
    const msg = await message.reply("Pinging...");
    const messageLatency = Date.now() - messageStart;
    const fluxerRestStart = Date.now();
    await fluxerClient.rest.get(FluxerRoutes.currentUser());
    const fluxerRestLatency = Date.now() - fluxerRestStart;
    const discordRestStart = Date.now();
    await discordClient.rest.get(Routes.currentApplication());
    const discordRestLatency = Date.now() - discordRestStart;

    const messagesBridged = await MessageMap.count();
    const channelsBridged = await ChannelMap.count();
    const discordGuildCount = discordClient.guilds.cache.size;
    const fluxerGuildCount = fluxerClient.guilds.size;
    const discordMemberCount = discordClient.guilds.cache.reduce(
      (acc, guild) => acc + guild.memberCount,
      0,
    );
    const fluxerMemberCount = fluxerClient.guilds.reduce(
      (acc, guild) => acc + (guild.memberCount ?? guild.members.size),
      0,
    );
    const heapMb =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
    const discordPing =
      typeof discordClient.ws.ping === "number" && discordClient.ws.ping >= 0
        ? `${Math.round(discordClient.ws.ping)}ms`
        : "n/a";
    const fluxerPing =
      fluxerClient.isReady() &&
      typeof fluxerClient.ws.ping === "number" &&
      fluxerClient.ws.ping >= 0
        ? `${Math.round(fluxerClient.ws.ping)}ms`
        : "n/a";
    await msg.edit({
      content: "",
      //@ts-expect-error
      embeds: [
        new EmbedBuilder()
          .setTitle("Pong!")
          .setDescription(
            `Bridging ${channelsBridged} channel${channelsBridged === 1 ? "" : "s"} (${messagesBridged} messages) for ${getDuration(botStartingTime, now)}`,
          )
          .addFields(
            {
              name: (isFluxer ? "Fluxer" : "Discord") + " round-trip",
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
            {
              name: "Discord gateway",
              value: discordPing,
              inline: true,
            },
            {
              name: "Fluxer gateway",
              value: fluxerPing,
              inline: true,
            },
            {
              name: "Memory",
              value: `${heapMb} MB`,
              inline: true,
            },
            {
              name: "Discord guilds",
              value: discordGuildCount + "",
              inline: true,
            },
            {
              name: "Fluxer guilds",
              value: fluxerGuildCount + "",
              inline: true,
            },
            {
              name: "\u200b",
              value: "\u200b",
              inline: true,
            },
            {
              name: "Discord members",
              value: discordMemberCount + "",
              inline: true,
            },
            {
              name: "Fluxer members",
              value: fluxerMemberCount + "",
              inline: true,
            },
            {
              name: "\u200b",
              value: "\u200b",
              inline: true,
            },
          )
          .setFooter(
            Config.EmbedFooterContent
              ? { text: Config.EmbedFooterContent }
              : null,
          ),
      ],
    });
  },
};

export default command;
