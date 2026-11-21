import { GuildMap, BridgeEndpoint } from "../db/index.js";
import { Op } from "sequelize";
import { getFluxerInstanceName } from "./GetFluxerUrls.js";

const MAX_WEBHOOK_NAME = 80;

function shortIndicator(name) {
  const caps = (name ?? "").replace(/[^A-Z]/g, "");
  if (caps.length > 0) return caps;
  const first = (name ?? "").trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

async function bridgeWebGuildIds(guildIds) {
  const seed = [...new Set(guildIds.filter(Boolean))];
  if (seed.length === 0) return [];
  const own = await BridgeEndpoint.findAll({ where: { guildId: seed }, attributes: ["groupId"], raw: true });
  const groupIds = [...new Set(own.map(e => e.groupId))];
  if (groupIds.length === 0) return seed;
  const others = await BridgeEndpoint.findAll({
    where: { groupId: groupIds, guildId: { [Op.notIn]: seed } },
    attributes: ["guildId"],
    raw: true,
  });
  return [...new Set([...seed, ...others.map(e => e.guildId)].filter(Boolean))];
}

export async function resolveNameIndicator(receiverGuildId, senderGuildId) {
  const guildIds = await bridgeWebGuildIds([receiverGuildId, senderGuildId]);
  if (guildIds.length === 0) return null;

  const rows = await GuildMap.findAll({
    where: { guildId: guildIds },
    attributes: ["guildId", "nameIndicator", "guildType", "fluxerInstanceId"],
    raw: true,
  });
  if (rows.length === 0) return null;

  const styledRows = rows.filter(x => x.nameIndicator === "full" || x.nameIndicator === "short");
  if (styledRows.length === 0) return null;

  const styleRow = styledRows[0];
  const style = styleRow.nameIndicator === "short" ? "short" : "full";
  const senderRow = (senderGuildId && rows.find(x => x.guildId === senderGuildId)) ?? styleRow;

  if (senderRow.guildType === "fluxer") {
    const instanceName = await getFluxerInstanceName(senderRow.fluxerInstanceId ?? "default");
    if (style === "short") return { discord: "[D]", fluxer: `[${shortIndicator(instanceName)}]` };
    return { discord: "[Discord]", fluxer: `[${instanceName}]` };
  }
  if (style === "short") return { discord: "[D]", fluxer: "[F]" };
  return { discord: "[Discord]", fluxer: "[Fluxer]" };
}

export function indicatorPrefix(platform, indicator) {
  return indicator ? `${indicator[platform]} ` : "";
}

export function withIndicator(name, platform, indicator) {
  const prefix = indicatorPrefix(platform, indicator);
  if (!prefix) return name;
  return prefix + name.slice(0, MAX_WEBHOOK_NAME - prefix.length);
}
