import { UserConfig } from "../db/index.js";
import DefaultConfig from "./ConfigHandler.js";
import { Message } from "@fluxerjs/core";

const PROXY_PREFIXES = ["fish!", "pk;"];
const PROXY_COMMANDS = [
  "register",
  "list",
  "reproxy",
  "autoproxy",
  "ap",
  "set",
];

/**
 * @param {import("@fluxerjs/core").Message | import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean>>} message
 */
export async function detectProxyCommandCompat(message) {
  const firstWord = message.content.split(" ")[0];
  if (
    PROXY_PREFIXES.find((x) => firstWord.startsWith(x)) &&
    PROXY_COMMANDS.find((x) => firstWord.endsWith(x))
  ) {
    const cfg = await UserConfig.findOne({
      where: {
        userId: message.author.id,
      },
    });

    // we don't want to override user config so we don't
    // touch user if there's already a config
    if (cfg) return;

    await UserConfig.create({
      userType: message instanceof Message ? "fluxer" : "discord",
      userId: message.author.id,
      proxyCompatibility: true,
    });

    // then we DM that person
    try {
      await message.author.send(
        `Hey! We detected that you sent a message in ${
          message.guild.name
        } that contains a proxy bot's command, so we enabled` +
          "Proxy Compatibility mode for you. If you want to disable it, just run `" +
          `${DefaultConfig.BotPrefix}proxycompatibility\`, and we won't touch it ever again.`,
      );
    } catch {
      await message.reply(
        `Hey! We detected that you sent a message in ${
          message.guild.name
        } that contains a proxy bot's command, so we enabled` +
          " Proxy Compatibility mode for you. If you want to disable it, just run `" +
          `${DefaultConfig.BotPrefix}proxycompatibility\`, and we won't touch it ever again.`,
      );
    }
  }
}
