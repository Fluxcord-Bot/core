import { MessageMap } from "../db/index.js";
import { isUserOptedOut } from "./UserOptOut.js";

const WAIT_INTERVAL_MS = 250;
const WAIT_TIMEOUT_MS = 60_000;
const MAX_REFERENCE_AGE_MS = 2 * 60 * 1000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {"discord" | "fluxer"} platform
 * @param {string} messageId
 * @param {number} channelMapId
 * @param {string | undefined} authorId
 * @param {Date | undefined} createdAt
 */
export async function waitForMessageMap(platform, messageId, channelMapId, authorId, createdAt) {
  if (!messageId || !channelMapId || !authorId || !(createdAt instanceof Date)) return null;
  if (Date.now() - createdAt.getTime() > MAX_REFERENCE_AGE_MS) return null;
  if (await isUserOptedOut(platform, authorId)) return null;

  const idField = platform === "discord" ? "discordMessageId" : "fluxerMessageId";
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const messageMap = await MessageMap.findOne({
      where: {
        [idField]: messageId,
      },
    });

    if (messageMap) {
      return messageMap.channelMapId === channelMapId ? messageMap : null;
    }

    await delay(WAIT_INTERVAL_MS);
  }

  return null;
}
