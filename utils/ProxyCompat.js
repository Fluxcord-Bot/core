import fuzzyMatching from "fuzzymatchingjs";

const pendingMessages = new Map();
const PENDING_TTL_MS = 8000;

/**
 * @param {string} messageId
 */
export function registerPendingMessage(messageId, content) {
  pendingMessages.set(messageId, {
    content: normalizeContent(content),
    timestamp: Date.now(),
  });

  setTimeout(() => pendingMessages.delete(messageId), PENDING_TTL_MS);
}

function evictExpiredPending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, entry] of pendingMessages) {
    if (entry.timestamp < cutoff) pendingMessages.delete(id);
  }
}

/**
 * @param {string} content
 */
export function normalizeContent(content) {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isProxyDuplicate(
  incomingMessageId,
  incomingContent,
  recentMessages,
) {
  evictExpiredPending();
  const normalizedIncoming = normalizeContent(incomingContent);
  if (!normalizedIncoming) return false;

  for (const [id, entry] of pendingMessages) {
    if (id === incomingMessageId) continue;
    if (isContentMatch(normalizedIncoming, entry.content)) return true;
  }

  return recentMessages.some((x) => {
    const normalizedStored = normalizeContent(x.content);
    if (!normalizedStored) return false;
    return isContentMatch(normalizedIncoming, normalizedStored);
  });
}

function isContentMatch(a, b) {
  if (a === b) return true;

  const shorter = Math.min(a.length, b.length);
  if (shorter >= 8 && (a.includes(b) || b.includes(a))) return true;

  return fuzzyMatching.confidenceScore(a, b) > 0.85;
}
