import { Message as FluxerMessage } from "@fluxerjs/core";
import { getGuildOptInState, isUserOptedOut, setGuildOptInState, setUserOptedOut } from "../../utils/UserOptOut.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["user", "u"],
  name: "opt-in",
  aliases: ["optin"],
  topLevelAliases: ["optin", "opt-in"],
  description: "Resume bridging globally or opt in to this guild/community only",
  requireElevated: false,
  params: "[global] [confirm]",
  slashOptions: [
    {
      name: "scope",
      type: "string",
      choices: [{ name: "global", value: "global" }],
    },
  ],
  async run(params, message) {
    const isFluxer = message instanceof FluxerMessage;
    const userType = isFluxer ? "fluxer" : "discord";
    const community = isFluxer ? "community" : "guild";
    const scope = params.find(param => param.toLowerCase() !== "confirm")?.toLowerCase();

    if (!message.guildId) {
      await message.reply(`Fluxcord commands cannot be used in DMs. Run \`user opt-in\` in the ${community} where you want bridging enabled.`);
      return;
    }

    if (scope && scope !== "global") {
      await message.reply(`Usage: \`user opt-in\` for this ${community} only, or \`user opt-in global\` to resume bridging globally.`);
      return;
    }

    if (scope === "global") {
      if (!(await isUserOptedOut(userType, message.author.id))) {
        await message.reply("You are not currently opted out of bridging.");
        return;
      }

      await setUserOptedOut(userType, message.author.id, false);

      await message.reply("Done, Your messages will be bridged again.");
      return;
    }

    const existing = await getGuildOptInState(userType, message.guildId, message.author.id);
    if (existing?.optedIn === true) {
      await message.reply(`You are already opted in to bridging in this ${community}.`);
      return;
    }

    await setGuildOptInState(userType, message.guildId, message.author.id, true);
    await message.reply(`Done, Your opt-in for this ${community} was saved.`);
  },
};

export default command;
