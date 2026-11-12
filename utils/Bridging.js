import { BridgeGroup, BridgeEndpoint, MessageLink, GuildMap } from "../db/index.js";
import { Op } from "sequelize";
import { randomUUID } from "node:crypto";
import { log } from "./Logger.js";

/**
 * @param {"discord" | "fluxer"} platform
 * @param {string} channelId
 * @param {import("sequelize").FindOptions} [opts]
 * @returns {Promise<BridgeEndpoint[]>}
 */
export function findEndpoints(platform, channelId, opts) {
  return BridgeEndpoint.findAll({ where: { platform, channelId }, ...opts });
}

/**
 * @param {"discord" | "fluxer"} platform
 * @param {string} channelId
 * @returns {Promise<BridgeEndpoint?>}
 */
export async function findEndpoint(platform, channelId) {
  return BridgeEndpoint.findOne({ where: { platform, channelId } });
}

/**
 * @param {number} groupId
 * @param {number[]} [excludeIds]
 * @returns {Promise<BridgeEndpoint[]>}
 */
export function groupEndpoints(groupId, excludeIds = []) {
  const where = { groupId };
  if (excludeIds.length > 0) where.id = { [Op.notIn]: excludeIds };
  return BridgeEndpoint.findAll({ where });
}

/**
 * @param {BridgeEndpoint} endpoint
 * @param {number[]} [excludeGroupIds]
 * @returns {Promise<BridgeEndpoint[]>}
 */
export async function fanoutTargets(endpoint, excludeGroupIds = []) {
  const own = await findEndpoints(endpoint.platform, endpoint.channelId);
  const ownIds = new Set(own.map(e => e.id));
  const groupIds = [...new Set(own.map(e => e.groupId))].filter(g => !excludeGroupIds.includes(g));
  if (groupIds.length === 0) return [];
  const rows = await BridgeEndpoint.findAll({
    where: { groupId: { [Op.in]: groupIds }, id: { [Op.notIn]: [...ownIds] } },
  });
  return rows;
}

/**
 * @param {BridgeEndpoint} endpoint
 * @returns {Promise<BridgeGroup?>}
 */
export async function endpointGroup(endpoint) {
  return BridgeGroup.findByPk(endpoint.groupId);
}

const RELAY_TTL_MS = 10 * 60_000;

const relayRecords = new Map();

function relayKey(endpointId, webhookId) {
  return `${endpointId}:${webhookId}`;
}

/**
 * @returns {void}
 */
export function sweepRelayRecords() {
  const now = Date.now();
  for (const [key, value] of relayRecords) {
    if (now - value.at > RELAY_TTL_MS) relayRecords.delete(key);
  }
}

/**
 * @param {number} endpointId
 * @param {string} webhookId
 * @param {string} linkGroup
 * @param {number | null} sourceGroupId
 * @returns {void}
 */
export function recordRelay(endpointId, webhookId, linkGroup, sourceGroupId) {
  if (!webhookId) return;
  relayRecords.set(relayKey(endpointId, webhookId), { linkGroup, sourceGroupId, at: Date.now() });
  if (relayRecords.size > 5000) sweepRelayRecords();
}

/**
 * @param {number} endpointId
 * @param {string} webhookId
 * @returns {{ linkGroup: string, sourceGroupId: number, at: number } | null}
 */
export function getRelay(endpointId, webhookId) {
  if (!webhookId) return null;
  const record = relayRecords.get(relayKey(endpointId, webhookId));
  if (!record) return null;
  if (Date.now() - record.at > RELAY_TTL_MS) {
    relayRecords.delete(relayKey(endpointId, webhookId));
    return null;
  }
  return record;
}

/**
 * @returns {string}
 */
export function newLinkGroup() {
  return randomUUID();
}

/**
 * @param {number} endpointId
 * @param {string} messageId
 * @returns {Promise<MessageLink[]>}
 */
/**
 * @param {number} endpointId
 * @param {string} messageId
 * @returns {Promise<MessageLink?>}
 */
export function findLinks(endpointId, messageId) {
  return MessageLink.findAll({ where: { endpointId, messageId } });
}

export function findLink(endpointId, messageId) {
  return MessageLink.findOne({ where: { endpointId, messageId } });
}

/**
 * @param {string} linkGroup
 * @returns {Promise<(MessageLink & { endpoint?: BridgeEndpoint })[]>}
 */
export function findLinkSiblings(linkGroup) {
  return MessageLink.findAll({ where: { linkGroup }, include: ["endpoint"] });
}

/**
 * @param {string} linkGroup
 * @param {number} endpointId
 * @param {string} messageId
 * @param {string | null} [replyId]
 * @param {string | null} [authorId]
 * @returns {Promise<MessageLink | null>} existing row when it already existed, null when newly created
 */
export async function ensureLink(linkGroup, endpointId, messageId, replyId = null, authorId = null) {
  const existing = await MessageLink.findOne({ where: { linkGroup, endpointId } });
  if (existing) return existing;
  try {
    await MessageLink.create({ linkGroup, endpointId, messageId, replyId, authorId });
    return null;
  } catch (e) {
    log("DB", `Failed to save message link (group ${linkGroup}, endpoint ${endpointId})`, e);
    return null;
  }
}

const DELETED_TTL_MS = 2 * 60_000;

const deletedGroups = new Map();

/**
 * @param {string} linkGroup
 * @returns {void}
 */
export function markDeletedGroup(linkGroup) {
  if (!linkGroup) return;
  deletedGroups.set(linkGroup, Date.now());
  if (deletedGroups.size > 2000) {
    const now = Date.now();
    for (const [key, at] of deletedGroups) {
      if (now - at > DELETED_TTL_MS) deletedGroups.delete(key);
    }
  }
}

/**
 * @param {string} linkGroup
 * @returns {boolean}
 */
export function isDeletedGroup(linkGroup) {
  if (!linkGroup) return false;
  const at = deletedGroups.get(linkGroup);
  if (!at) return false;
  if (Date.now() - at > DELETED_TTL_MS) {
    deletedGroups.delete(linkGroup);
    return false;
  }
  return true;
}

/**
 * @param {"discord" | "fluxer"} guildType
 * @param {string} guildId
 * @param {string} [instanceId]
 * @returns {Promise<GuildMap>}
 */
export async function findOrCreateGuildMap(guildType, guildId, instanceId = "default") {
  const where = guildType === "fluxer" ? { guildId, guildType, fluxerInstanceId: instanceId } : { guildId, guildType };
  const [map] = await GuildMap.findOrCreate({ where });
  return map;
}
