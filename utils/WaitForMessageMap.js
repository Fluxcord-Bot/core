import { MessageLink } from "../db/index.js";
import { canUserBridge } from "./UserOptOut.js";

const WAIT_INTERVAL_MS = 250;
const WAIT_TIMEOUT_MS = 60_000;
const MAX_REFERENCE_AGE_MS = 2 * 60 * 1000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {"discord" | "fluxer"} platform
 * @param {string} messageId
 * @param {string | undefined} authorId
 * @param {Date | undefined} createdAt
 * @param {string | undefined | null} guildId
 * @returns {Promise<MessageLink?>}
 */
export async function waitForMessageMap(platform, messageId, authorId, createdAt, guildId) {
  if (!messageId || !authorId || !(createdAt instanceof Date)) return null;
  if (Date.now() - createdAt.getTime() > MAX_REFERENCE_AGE_MS) return null;
  if (!(await canUserBridge(platform, authorId, guildId))) return null;

  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const link = await MessageLink.findOne({ where: { messageId }, include: ["endpoint"] });

    if (link) {
      if (link.endpoint?.platform === platform) return link;
      return link;
    }

    await delay(WAIT_INTERVAL_MS);
  }

  return null;
}
