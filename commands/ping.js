import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { EmbedBuilder, Routes as FluxerRoutes } from "@fluxerjs/core";
import { Routes } from "discord.js";
import Package from "../package.json" with { type: "json" };
import { BridgeEndpoint, MessageLink } from "../db/index.js";
import { getDuration } from "../utils/GetDuration.js";
import { botStartingTime } from "../index.js";
import getCommitHash from "../utils/GetCommitHash.js";
import { fluxerClients } from "../utils/FluxerClients.js";
import { getFluxerInstances } from "../utils/ConfigHandler.js";
import { embedFooterForMessage } from "../utils/PerInstance.js";

function readInstalledVersion(name) {
  try {
    const url = new URL(`../node_modules/${name}/package.json`, import.meta.url);
    return JSON.parse(fs.readFileSync(url, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function instanceHost(instanceId, configured) {
  const instance = configured.find(entry => entry.id === instanceId);
  if (!instance?.FluxerAPIBaseURL) return instanceId;
  try {
    return new URL(instance.FluxerAPIBaseURL).hostname.replace(/^api\./, "");
  } catch {
    return instanceId;
  }
}

function platformName() {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return process.platform;
  }
}

function isDocker() {
  return fs.existsSync("/.dockerenv") || process.env.FLUXCORD_DOCKER === "1";
}

function pnpmVersion() {
  try {
    return execSync("pnpm --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "ping",
  description: "...pong? (bot latency and stats)",
  aliases: ["stats", "uptime"],
  requireElevated: false,
  allowDM: true,
  async run(params, message, discordClient, fluxerClient) {
    const now = new Date();
    const msg = await message.reply("Pinging...");
    const configuredInstances = getFluxerInstances();
    const fluxerInstances = [...fluxerClients.entries()];
    const fluxerRestLatencies = await Promise.all(
      fluxerInstances.map(async ([instanceId, client]) => {
        const start = Date.now();
        try {
          await client.rest.get(FluxerRoutes.currentUser());
          return { instanceId, value: `${Date.now() - start}ms` };
        } catch {
          return { instanceId, value: "n/a" };
        }
      })
    );
    const discordRestStart = Date.now();
    await discordClient.rest.get(Routes.currentApplication());
    const discordRestLatency = Date.now() - discordRestStart;

    const messagesBridged = await MessageLink.count({ distinct: true, col: "linkGroup" });
    const channelsBridged = await BridgeEndpoint.count({
      distinct: true,
      col: "BridgeGroupId",
      where: { kind: "channel" },
    });
    const discordGuildCount = discordClient.guilds.cache.size;
    const discordMemberCount = discordClient.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
    const discordPing =
      typeof discordClient.ws.ping === "number" && discordClient.ws.ping >= 0 ? `${Math.round(discordClient.ws.ping)}ms` : "n/a";

    const instanceLines = ["discord.com"];
    const latencyLines = [`${discordRestLatency}ms REST, ${discordPing} GW`];
    const countLines = [
      `${discordGuildCount} guild${discordGuildCount === 1 ? "" : "s"}, ${discordMemberCount} user${discordMemberCount === 1 ? "" : "s"}`,
    ];
    for (const [instanceId, client] of fluxerInstances) {
      const rest = fluxerRestLatencies.find(entry => entry.instanceId === instanceId)?.value ?? "n/a";
      const ping =
        client.isReady() && typeof client.ws.ping === "number" && client.ws.ping >= 0
          ? `${Math.round(client.ws.ping)}ms`
          : "n/a";
      const guildCount = client.guilds.size;
      const memberCount = client.guilds.reduce(
        (acc, guild) => acc + (guild.memberCount ?? guild.members.size),
        0
      );
      instanceLines.push(instanceHost(instanceId, configuredInstances));
      latencyLines.push(`${rest} REST, ${ping} GW`);
      countLines.push(
        `${guildCount} guild${guildCount === 1 ? "" : "s"}, ${memberCount} user${memberCount === 1 ? "" : "s"}`
      );
    }

    const load = os.loadavg()[0].toFixed(2);
    const cpuCount = os.cpus().length;
    const ramMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const nodeVersion = process.version;
    const pnpm = pnpmVersion();
    const fluxerVersion = readInstalledVersion("@fluxerjs/core");
    const discordVersion = readInstalledVersion("discord.js");
    const systemLines = [
      `Load ${load} in ${cpuCount} CPU${cpuCount === 1 ? "" : "s"}, ${ramMb}MB used RAM`,
      `Running ${isDocker() ? "on docker" : "bare metal"} in ${platformName()} ${process.arch}`,
      `Node.js ${nodeVersion}${pnpm ? `, pnpm ${pnpm}` : ""}`,
      `${fluxerVersion ? `@fluxerjs/core v${fluxerVersion}` : "@fluxerjs/core n/a"}, ${discordVersion ? `discord.js v${discordVersion}` : "discord.js n/a"}`,
    ];

    await msg.edit({
      content: "",
      //@ts-expect-error
      embeds: [
        new EmbedBuilder()
          .setTitle(`Fluxcord Stats (${Package.version}+${getCommitHash()})`)
          .setDescription(
            `Bridging ${messagesBridged} message${messagesBridged === 1 ? "" : "s"} in ${channelsBridged} channel${channelsBridged === 1 ? "" : "s"}, bot running for ${getDuration(botStartingTime, now)}`
          )
          .setColor(4992474)
          .addFields(
            {
              name: "Instance",
              value: instanceLines.join("\n"),
              inline: true,
            },
            {
              name: "Latency",
              value: latencyLines.join("\n"),
              inline: true,
            },
            {
              name: "Counts",
              value: countLines.join("\n"),
              inline: true,
            },
            {
              name: "System",
              value: systemLines.join("\n"),
              inline: false,
            }
          )
          .setFooter(embedFooterForMessage(message) ? { text: embedFooterForMessage(message) } : null),
      ],
    });
  },
};

export default command;
