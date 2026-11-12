import { BridgeGroup, BridgeEndpoint, MessageLink } from "../../db/index.js";
import { findEndpoints } from "../Bridging.js";
import { Op } from "sequelize";

export function directionAllowed(sourcePlatform, targetPlatform, bridgeType) {
  if (sourcePlatform === targetPlatform) return bridgeType === "both";
  if (sourcePlatform === "fluxer") return bridgeType !== "discord2fluxer";
  return bridgeType !== "fluxer2discord";
}

export async function collectTargets(sourceEndpoints, sourcePlatform, opts = {}) {
  const { excludeGroupIds = [], kind, excludeChannelId } = opts;

  const groupIds = [...new Set(sourceEndpoints.map(e => e.groupId))].filter(id => !excludeGroupIds.includes(id));
  if (groupIds.length === 0) return [];

  const groups = await BridgeGroup.findAll({ where: { id: { [Op.in]: groupIds } }, raw: true });
  const typeById = new Map(groups.map(g => [g.id, g.bridgeType]));

  const candidates = await BridgeEndpoint.findAll({ where: { groupId: { [Op.in]: groupIds } }, raw: true });

  const byChannel = new Map();
  for (const t of candidates) {
    if (excludeChannelId && t.platform === sourcePlatform && t.channelId === excludeChannelId) continue;
    if (kind && t.kind !== kind) continue;
    if (!directionAllowed(sourcePlatform, t.platform, typeById.get(t.groupId))) continue;
    const key = `${t.platform}:${t.channelId}`;
    let entry = byChannel.get(key);
    if (!entry) {
      entry = { key, endpoints: [], bridgeType: typeById.get(t.groupId) };
      byChannel.set(key, entry);
    }
    entry.endpoints.push(t);
  }

  return [...byChannel.values()];
}

export function channelEndpoints(endpoint) {
  return findEndpoints(endpoint.platform, endpoint.channelId, { raw: true });
}

export async function linkedGroupIds(linkGroup, endpoints) {
  const rows = await MessageLink.findAll({ where: { linkGroup }, attributes: ["endpointId"], raw: true });
  const linked = new Set(rows.map(r => r.endpointId));
  return [...new Set(endpoints.filter(e => linked.has(e.id)).map(e => e.groupId))];
}
