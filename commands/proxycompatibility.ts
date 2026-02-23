import { Message, EmbedBuilder } from "@fluxerjs/core";
import Config from "../config";
import type { CommandSchema } from "../utils/CommandSchema";
import { commands } from "../utils/CommandHandler";
import { UserConfig } from "../db";

const command: CommandSchema = {
  name: "proxycompatibility",
  description: "Toggle Proxy Compatibility Mode",
  requireElevated: false,
  additionalInfo:
    "If enabled, instead of bridging your message immediately, it will wait for the proxy bot to send the right version of the message and Fluxcord will bridge that instead.",
  async run(params, message, _, _2) {
    const userConfig = await UserConfig.findOrCreate({
      where: {
        userId: message.author.id,
      },
      defaults: {
        userType: message instanceof Message ? "fluxer" : "discord",
        userId: message.author.id,
      },
    });

    userConfig[0].proxyCompatibility = !userConfig[0].proxyCompatibility;
    userConfig[0].save();

    await message.reply({
      content:
        "Proxy Compatibility Mode is now " +
        (userConfig[0].proxyCompatibility ? "enabled" : "disabled") +
        "!",
    });
  },
};

export default command;
