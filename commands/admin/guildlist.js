import { EmbedBuilder, Message as FluxerMessage } from "@fluxerjs/core";
import { BridgeEndpoint, MessageLink } from "../../db/index.js";
import { getFluxerClient } from "../../utils/FluxerClients.js";
import { col, fn, Op } from "sequelize";

/**
 * @template T
 * @param {T[]} array
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

async function countEndpointsByGuild(guildIds, platform, instanceId) {
  if (!guildIds.length) return {};

  const rows = await BridgeEndpoint.findAll({
    attributes: ["guildId", [fn("COUNT", col("id")), "endpointCount"]],
    where: {
      ...(platform && { platform }),
      ...(instanceId && { instanceId }),
      guildId: { [Op.in]: guildIds },
    },
    group: ["guildId"],
    raw: true,
  });

  const counts = Object.fromEntries(rows.map(r => [r.guildId, Number(r.endpointCount)]));
  return Object.fromEntries(guildIds.map(id => [id, counts[id] ?? 0]));
}

async function countEndpointsByGuildChunked(guildIds, platform, instanceId, chunkSize = 500) {
  const results = await Promise.all(chunk(guildIds, chunkSize).map(c => countEndpointsByGuild(c, platform, instanceId)));
  return Object.assign({}, ...results);
}

async function countMessagesByGuild(guildIds, platform, instanceId) {
  if (!guildIds.length) return {};

  const rows = await MessageLink.findAll({
    attributes: [
      [col("endpoint.guildId"), "guildId"],
      [fn("COUNT", col("MessageLink.id")), "messageCount"],
    ],
    include: [
      {
        model: BridgeEndpoint,
        as: "endpoint",
        attributes: [],
        required: true,
        where: {
          ...(platform && { platform }),
          ...(instanceId && { instanceId }),
          guildId: { [Op.in]: guildIds },
        },
      },
    ],
    group: ["endpoint.guildId"],
    raw: true,
  });

  const counts = Object.fromEntries(rows.map(r => [r.guildId, Number(r.messageCount)]));
  return Object.fromEntries(guildIds.map(id => [id, counts[id] ?? 0]));
}

async function countMessagesByGuildChunked(guildIds, platform, instanceId, chunkSize = 500) {
  const results = await Promise.all(chunk(guildIds, chunkSize).map(c => countMessagesByGuild(c, platform, instanceId)));
  return Object.assign({}, ...results);
}

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["a", "admin"],
  name: "guildlist",
  aliases: ["gl"],
  description: "List guilds using Fluxcord",
  requireElevated: false,
  requireOwner: true,
  params: `[page=0] [instance=default|discord] [sort:memberCount|endpointCount|messageCount=memberCount]`,
  async run(params, message, discordClient, fluxerClient) {
    const isFluxer = message instanceof FluxerMessage;
    const page = Number.parseInt(params[0] ?? "0") || 0;
    const instance = params[1] ?? (isFluxer ? "default" : "discord");
    const sortKey = params[2] ?? "memberCount";
    const PAGE_SIZE = 15;

    if (!["memberCount", "endpointCount", "messageCount"].includes(sortKey)) {
      return message.reply("Sort must be one of: memberCount, endpointCount, messageCount");
    }

    const platform = instance === "discord" ? "discord" : "fluxer";
    const instanceId = platform === "fluxer" ? instance : undefined;

    let instanceName = "";

    let rawGuilds;
    if (platform === "fluxer") {
      const fluxInst = getFluxerClient(instance);
      const discovery = await fluxInst.fetchInstance();
      instanceName = discovery.app_public.branding?.product_name;
      const g = fluxInst.guilds;
      rawGuilds = Array.isArray(g) ? g : [...g.values()];
    } else {
      rawGuilds = [...discordClient.guilds.cache.values()];
    }

    let guilds = rawGuilds.map(g => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount ?? 0,
    }));

    const fillCounts = async list => {
      const ids = list.map(g => g.id);
      const [endpointCounts, messageCounts] = await Promise.all([
        countEndpointsByGuildChunked(ids, platform, instanceId),
        countMessagesByGuildChunked(ids, platform, instanceId),
      ]);
      return list.map(g => ({
        ...g,
        endpointCount: endpointCounts[g.id] ?? 0,
        messageCount: messageCounts[g.id] ?? 0,
      }));
    };

    const totalPages = Math.max(1, Math.ceil(guilds.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * PAGE_SIZE;

    let pageGuilds;
    if (sortKey === "memberCount") {
      guilds.sort((a, b) => b.memberCount - a.memberCount);
      pageGuilds = await fillCounts(guilds.slice(start, start + PAGE_SIZE));
    } else {
      guilds = await fillCounts(guilds);
      guilds.sort((a, b) => b[sortKey] - a[sortKey]);
      pageGuilds = guilds.slice(start, start + PAGE_SIZE);
    }

    const lines = pageGuilds.map((g, i) => ({
      name: `**${g.name}** (\`${g.id}\`): `,
      value: `${g.memberCount} members, ${g.endpointCount} endpoints, ${g.messageCount} messages`,
    }));

    const embed = new EmbedBuilder();
    embed.setTitle(`Guilds on ${platform === "discord" ? "Discord" : (instanceName ?? "Fluxer")}`);
    embed.setFooter({
      text: `Sorted by ${sortKey}, Page ${safePage + 1}/${totalPages}`,
    });
    embed.addFields(...lines);

    return message.reply({
      embeds: [embed],
    });
  },
};

export default command;
