const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const WIDTH = 5;
const ID_WIDTH = 11;
const DISCORD_EPOCH_MS = 1420070400000;
const MAX_EMOJI_NAME = 32;

/**
 * @param {number} n
 * @param {number} [width]
 * @returns {string}
 */
function encodeBase62(n, width = WIDTH) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`Value must be a non-negative safe integer, got ${n}`);
  }
  let out = "";
  while (n > 0) {
    out = ALPHABET[n % 62] + out;
    n = Math.floor(n / 62);
  }
  if (out.length > width) {
    throw new RangeError(`Value needs ${out.length} chars, which exceeds width ${width}`);
  }
  return out.padStart(width, "0");
}

/**
 * @param {string} s
 * @returns {number}
 */
function decodeBase62(s) {
  let n = 0;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i === -1) throw new Error(`Invalid base62 character: ${c}`);
    n = n * 62 + i;
  }
  return n;
}

/**
 * @param {string | bigint} value
 * @param {number} [width]
 * @returns {string}
 */
function encodeBigBase62(value, width = ID_WIDTH) {
  let n = BigInt(value);
  if (n < 0n) throw new RangeError(`Value must be non-negative, got ${value}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  if (out.length > width) {
    throw new RangeError(`Value needs ${out.length} chars, which exceeds width ${width}`);
  }
  return out.padStart(width, "0");
}

/**
 * @param {string} s
 * @returns {bigint}
 */
function decodeBigBase62(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i === -1) throw new Error(`Invalid base62 character: ${c}`);
    n = n * 62n + BigInt(i);
  }
  return n;
}

/**
 * @param {string} snowflake
 * @param {number} [width]
 * @returns {string}
 */
export function snowflakeToCustom(snowflake, width = WIDTH) {
  const msSinceEpoch = BigInt(snowflake) >> 22n;
  return encodeBase62(Number(msSinceEpoch / 1000n), width);
}

/**
 * @param {string} str
 * @returns {string}
 */
export function customToSnowflake(str) {
  const seconds = BigInt(decodeBase62(str));
  return ((seconds * 1000n) << 22n).toString();
}

/**
 * @param {string} str
 * @returns {Date}
 */
export function customToDate(str) {
  return new Date(DISCORD_EPOCH_MS + decodeBase62(str) * 1000);
}

/**
 * @param {Date} date
 * @param {number} [width]
 * @returns {string}
 */
export function dateToCustom(date, width = WIDTH) {
  return encodeBase62(Math.floor((date.getTime() - DISCORD_EPOCH_MS) / 1000), width);
}

/**
 * @param {string} id
 * @param {number} [width]
 * @returns {string}
 */
export function uniqueSuffix(id, width = 6) {
  return encodeBase62(Number(BigInt(id) % 62n ** BigInt(width)), width);
}

/**
 * @param {string} id
 * @param {number} [width]
 * @returns {string}
 */
export function idToSuffix(id, width = ID_WIDTH) {
  return encodeBigBase62(id, width);
}

/**
 * @param {string} suffix
 * @returns {string}
 */
export function suffixToId(suffix) {
  return decodeBigBase62(suffix).toString();
}

/**
 * @param {string} name
 * @param {string} snowflake
 * @param {{ mode?: "id" | "time" | "unique" }} [opts]
 * @returns {string}
 */
export function bridgeEmojiName(name, snowflake, { mode = "id" } = {}) {
  const suffix =
    mode === "unique" ? uniqueSuffix(snowflake) : mode === "time" ? snowflakeToCustom(snowflake) : idToSuffix(snowflake);
  const maxBase = MAX_EMOJI_NAME - 1 - suffix.length;
  const clean =
    String(name ?? "")
      .replace(/[^A-Za-z0-9_]/g, "_")
      .slice(0, maxBase) || "emoji";
  return `${clean}_${suffix}`;
}

/**
 * @param {string} bridged
 * @returns {{ name: string, suffix: string } | null}
 */
export function parseBridgeEmojiName(bridged) {
  const i = String(bridged).lastIndexOf("_");
  if (i <= 0) return null;
  return { name: bridged.slice(0, i), suffix: bridged.slice(i + 1) };
}

/**
 * @param {string} bridged
 * @returns {Date | null}
 */
export function bridgeEmojiNameToDate(bridged) {
  const parsed = parseBridgeEmojiName(bridged);
  return parsed ? customToDate(parsed.suffix) : null;
}

/**
 * @param {string} bridged
 * @returns {string | null}
 */
export function bridgeEmojiNameToId(bridged) {
  const parsed = parseBridgeEmojiName(bridged);
  if (!parsed || parsed.suffix.length !== ID_WIDTH) return null;
  try {
    return suffixToId(parsed.suffix);
  } catch {
    return null;
  }
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isBridgeEmojiName(name) {
  const parsed = parseBridgeEmojiName(name);
  if (!parsed) return false;
  const { suffix, name: base } = parsed;
  if (base.length === 0) return false;
  if (suffix.length !== WIDTH && suffix.length !== 6 && suffix.length !== ID_WIDTH) return false;
  return [...suffix].every(c => ALPHABET.includes(c));
}
