import { Message as FluxerMessage } from "@fluxerjs/core";
import { isUserOptedOut, setUserOptedOut } from "../../utils/UserOptOut.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["user", "u"],
  name: "opt-in",
  aliases: ["optin"],
  topLevelAliases: ["optin", "opt-in"],
  description: "Resume bridging your messages globally",
  requireElevated: false,
  allowDM: true,
  async run(_params, message) {
    const isFluxer = message instanceof FluxerMessage;
    const userType = isFluxer ? "fluxer" : "discord";

    if (!(await isUserOptedOut(userType, message.author.id))) {
      await message.reply("You are not currently opted out of bridging.");
      return;
    }

    await setUserOptedOut(userType, message.author.id, false);

    await message.reply("Done. Your messages will be bridged again.");
  },
};

export default command;
