import Config from "../utils/ConfigHandler.js";

/**
 * @param {string} type
 * @param {...any} msg
 */
export function log(type, ...msg) {
  if (!Config.LoggingCategories.includes(type)) return;
  console.log(
    `[${new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })} ${type}]`,
    ...msg,
  );
}
