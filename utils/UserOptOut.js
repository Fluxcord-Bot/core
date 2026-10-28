import { UserConfig } from "../db/index.js";

const OPTED_OUT_VALUE = "__opted_out__";

/**
 * @param {"discord" | "fluxer"} userType
 * @param {string | undefined | null} userId
 */
export async function isUserOptedOut(userType, userId) {
  if (!userId) return false;

  const config = await UserConfig.findOne({
    where: {
      userType,
      userId,
      doNotBridgePrefix: OPTED_OUT_VALUE,
    },
  });

  return Boolean(config);
}

/**
 * @param {"discord" | "fluxer"} userType
 * @param {string} userId
 * @param {boolean} optedOut
 */
export async function setUserOptedOut(userType, userId, optedOut) {
  const value = optedOut ? OPTED_OUT_VALUE : null;
  const [config] = await UserConfig.findOrCreate({
    where: {
      userType,
      userId,
    },
    defaults: {
      doNotBridgePrefix: value,
    },
  });

  if (config.doNotBridgePrefix !== value) {
    config.doNotBridgePrefix = value;
    await config.save();
  }

  return config;
}
