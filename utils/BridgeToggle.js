import { BridgeEndpoint, GuildMap } from "../db/index.js";
import { Op } from "sequelize";

function guildWhere(endpoint) {
  if (endpoint.platform === "fluxer") {
    return { guildType: "fluxer", guildId: endpoint.guildId, fluxerInstanceId: endpoint.instanceId ?? "default" };
  }
  return { guildType: "discord", guildId: endpoint.guildId };
}

/**
 * @param {BridgeEndpoint} endpoint
 * @returns {Promise<GuildMap[]>} guild maps of this channel's guild and every guild it is bridged to
 */
export async function linkedGuildMaps(endpoint) {
  const own = await BridgeEndpoint.findAll({
    where: { platform: endpoint.platform, channelId: endpoint.channelId },
    attributes: ["id", "platform", "guildId", "groupId", "instanceId"],
    raw: true,
  });

  const groupIds = [...new Set(own.map(e => e.groupId))];
  let others = [];
  if (groupIds.length > 0) {
    others = await BridgeEndpoint.findAll({ where: { groupId: { [Op.in]: groupIds } }, raw: true });
  }

  const seen = new Map();
  for (const e of [{ ...endpoint, platform: endpoint.platform, guildId: endpoint.guildId, instanceId: endpoint.instanceId }, ...own, ...others]) {
    const key = `${e.platform}:${e.guildId}`;
    if (!seen.has(key)) seen.set(key, e);
  }

  const guildMaps = [];
  for (const e of seen.values()) {
    const [row] = await GuildMap.findOrCreate({ where: guildWhere(e) });
    guildMaps.push(row);
  }

  return guildMaps;
}

/**
 * @param {BridgeEndpoint} endpoint
 * @param {string} field
 * @returns {Promise<boolean>}
 */
export async function isBridgeToggleEnabled(endpoint, field) {
  const guildMaps = await linkedGuildMaps(endpoint);
  return !guildMaps.some(g => g.get(field) === false);
}

/**
 * @param {string} guildId
 * @param {"discord" | "fluxer"} guildType
 * @returns {Promise<GuildMap[]>} guild maps of this guild and every guild it is bridged to
 */
export async function guildLinkedMaps(guildId, guildType) {
  const own = await BridgeEndpoint.findAll({
    where: { platform: guildType, guildId },
    attributes: ["platform", "guildId", "groupId", "instanceId"],
    raw: true,
  });

  const groupIds = [...new Set(own.map(e => e.groupId))];
  let others = [];
  if (groupIds.length > 0) {
    others = await BridgeEndpoint.findAll({ where: { groupId: { [Op.in]: groupIds } }, raw: true });
  }

  const seen = new Map();
  for (const e of [...own, ...others]) {
    const key = `${e.platform}:${e.guildId}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  if (seen.size === 0) seen.set(`${guildType}:${guildId}`, { platform: guildType, guildId, instanceId: "default" });

  const guildMaps = [];
  for (const e of seen.values()) {
    const [row] = await GuildMap.findOrCreate({ where: guildWhere(e) });
    guildMaps.push(row);
  }

  return guildMaps;
}

export const getBridgeGuildMaps = guildLinkedMaps;

/**
 * @param {BridgeEndpoint | string} target
 * @param {...any} rest
 * @returns {Promise<{ current: boolean, enabled: boolean, changed: boolean }>}
 */
export async function applyBridgeToggle(target, ...rest) {
  const isGuild = typeof target === "string";
  const guildMaps = isGuild ? await guildLinkedMaps(target, rest[0]) : await linkedGuildMaps(target);
  const field = isGuild ? rest[1] : rest[0];
  const requested = isGuild ? rest[2] : rest[1];
  const current = !guildMaps.some(g => g.get(field) === false);
  const enabled = requested ?? !current;

  if (enabled !== current) {
    for (const guildMap of guildMaps) {
      guildMap.set(field, enabled);
      await guildMap.save();
    }
  }

  return { current, enabled, changed: enabled !== current };
}

/**
 * @param {BridgeEndpoint | string} target
 * @param {...any} rest
 * @returns {Promise<{ current: any, changed: boolean }>}
 */
export async function applyBridgeValue(target, ...rest) {
  const isGuild = typeof target === "string";
  const guildMaps = isGuild ? await guildLinkedMaps(target, rest[0]) : await linkedGuildMaps(target);
  const field = isGuild ? rest[1] : rest[0];
  const value = isGuild ? rest[2] : rest[1];
  const neutral = isGuild ? rest[3] : rest[2];
  const current = guildMaps.find(g => g.get(field) !== neutral)?.get(field) ?? neutral;

  const changed = value !== undefined && value !== current;
  if (changed) {
    for (const guildMap of guildMaps) {
      guildMap.set(field, value);
      await guildMap.save();
    }
  }

  return { current, changed };
}
