import { Message } from "@fluxerjs/core";
import { UserConfig } from "../db/index.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "proxycompatibility",
  description: "Toggle Proxy Compatibility Mode",
  aliases: ["pxycmp", "proxycompat", "pxy", "pk", "fish"],
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
