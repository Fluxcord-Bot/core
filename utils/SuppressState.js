const STATE_TTL = 5000;

/** @type {Map<string, { suppressed: boolean, at: number }>} */
const writes = new Map();

/**
 * @param {string} messageId
 * @param {boolean} suppressed
 */
export function markSuppressWrite(messageId, suppressed) {
  const now = Date.now();
  for (const [id, write] of writes) if (now - write.at > STATE_TTL) writes.delete(id);
  writes.set(messageId, { suppressed, at: now });
}

/**
 * @param {string} messageId
 * @returns {boolean | undefined}
 */
export function knownSuppressState(messageId) {
  const write = writes.get(messageId);
  if (write === undefined || Date.now() - write.at > STATE_TTL) return undefined;
  return write.suppressed;
}
