import { GuildMap, GuildUserOptIn, UserConfig } from "../db/index.js";
import { getGuildPrefix } from "./GetGuildPrefix.js";
import { log } from "./Logger.js";

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
 * @param {string} guildId
 * @param {"discord" | "fluxer"} guildType
 */
export async function isGuildOptInEnabled(guildId, guildType) {
  const guildMap = await GuildMap.findOne({ where: { guildId, guildType } });
  return guildMap?.guildOptInEnabled === true;
}

/**
 * @param {"discord" | "fluxer"} guildType
 * @param {string} guildId
 * @param {string} userId
 */
export async function getGuildOptInState(guildType, guildId, userId) {
  return GuildUserOptIn.findOne({ where: { guildType, guildId, userId } });
}

/**
 * @param {"discord" | "fluxer"} guildType
 * @param {string} guildId
 * @param {string} userId
 * @param {boolean} optedIn
 */
export async function setGuildOptInState(guildType, guildId, userId, optedIn) {
  const [consent] = await GuildUserOptIn.findOrCreate({
    where: { guildType, guildId, userId },
    defaults: { optedIn, prompted: false },
  });
  if (consent.optedIn !== optedIn || consent.prompted) {
    consent.optedIn = optedIn;
    consent.prompted = false;
    await consent.save();
  }
  return consent;
}

/**
 * @param {"discord" | "fluxer"} userType
 * @param {string | undefined | null} userId
 * @param {string | undefined | null} guildId
 */
export async function canUserBridge(userType, userId, guildId) {
  if (!userId) return true;

  if (guildId) {
    const state = await getGuildOptInState(userType, guildId, userId);
    if (state?.optedIn === false && !state.prompted) return false;
    if (state?.optedIn === true && (await isGuildOptInEnabled(guildId, userType))) return true;
  }

  return !(await isUserOptedOut(userType, userId));
}

/**
 * @param {string} guildId
 * @param {"discord" | "fluxer"} guildType
 * @param {import("discord.js").User | import("@fluxerjs/core").User} user
 * @param {string} guildName
 */
export async function promptOptedOutUserOnFirstMessage(guildId, guildType, user, guildName) {
  if (!(await isGuildOptInEnabled(guildId, guildType))) return;
  if (!(await isUserOptedOut(guildType, user.id))) return;
  const consent = await getGuildOptInState(guildType, guildId, user.id);
  if (consent?.optedIn || consent?.prompted) return;

  try {
    await sendGuildOptInPrompt(user, guildName, guildId, guildType);
    await GuildUserOptIn.findOrCreate({
      where: { guildType, guildId, userId: user.id },
      defaults: { optedIn: false, prompted: true },
    });
  } catch (error) {
    log(guildType === "discord" ? "DISCORD" : "FLUXER", `Failed first-message opt-in prompt for user ${user.id} in ${guildId}`, error);
  }
}

/**
 * @param {{ createDM: () => Promise<{ send: (payload: { embeds: { title: string, description: string }[] }) => Promise<unknown> }> }} user
 * @param {string} guildName
 * @param {string} guildId
 * @param {"discord" | "fluxer"} guildType
 */
export async function sendGuildOptInPrompt(user, guildName, guildId, guildType) {
  const prefix = await getGuildPrefix(guildId);
  const community = guildType === "fluxer" ? "community" : "server";
  const dm = await user.createDM();
  await dm.send({
    embeds: [
      {
        title: "Bridging opt-in required",
        description:
          `To have your messages bridged in **${guildName}**, run \`${prefix}user opt-in\` in this ${community}.` +
          `That only opts you in here; your global opt-out will be respected.`
      },
    ],
  });
}

/**
 * @param {string} guildId
 * @param {"discord" | "fluxer"} guildType
 * @param {import("discord.js").Client} discordClient
 * @param {import("@fluxerjs/core").Client} fluxerClient
 */
export async function notifyExistingOptOutMembers(guildId, guildType, discordClient, fluxerClient) {
  const configs = await UserConfig.findAll({
    where: {
      userType: guildType,
      doNotBridgePrefix: OPTED_OUT_VALUE,
    },
    attributes: ["userId"],
  });
  const userIds = configs.map(config => config.userId);
  if (userIds.length === 0) return { sent: 0, failed: 0 };

  let guild;
  try {
    guild =
      guildType === "discord"
        ? await discordClient.guilds.fetch(guildId)
        : await fluxerClient.guilds.fetch(guildId);
  } catch (error) {
    log(guildType === "discord" ? "DISCORD" : "FLUXER", `Failed to fetch guild ${guildId} for opt-in notifications`, error);
    return { sent: 0, failed: 1 };
  }

  let sent = 0;
  let failed = 0;
  for (const userId of userIds) {
    const consent = await getGuildOptInState(guildType, guildId, userId);
    if (consent?.optedIn || consent?.prompted) continue;

    let member;
    try {
      member =
        guildType === "discord"
          ? await /** @type {import("discord.js").Guild} */ (guild).members.fetch(userId)
          : await /** @type {import("@fluxerjs/core").Guild} */ (guild).fetchMember(userId);
    } catch (error) {
      const unknownMember =
        error?.code === 10007 ||
        error?.code === "UNKNOWN_MEMBER" ||
        error?.code === "UNKNOWN_MEMBER_ID" ||
        error?.status === 404 ||
        error?.statusCode === 404;
      if (!unknownMember) {
        failed += 1;
        log(
          guildType === "discord" ? "DISCORD" : "FLUXER",
          `Failed to find opted-out user ${userId} in guild ${guildId}`,
          error
        );
      }
      continue;
    }

    try {
      await sendGuildOptInPrompt(member.user, guild.name, guildId, guildType);
      await GuildUserOptIn.findOrCreate({
        where: { guildType, guildId, userId },
        defaults: { optedIn: false, prompted: true },
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      log(
        guildType === "discord" ? "DISCORD" : "FLUXER",
        `Failed to DM opted-out user ${userId} for guild ${guildId}`,
        error
      );
    }
  }

  return { sent, failed };
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
