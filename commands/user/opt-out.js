import { Message as FluxerMessage } from "@fluxerjs/core";
import { getGuildPrefix } from "../../utils/GetGuildPrefix.js";
import { isUserOptedOut, setUserOptedOut } from "../../utils/UserOptOut.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["user", "u"],
  name: "opt-out",
  aliases: ["optout"],
  topLevelAliases: ["optout", "opt-out"],
  description: "Stop bridging your messages globally",
  requireElevated: false,
  allowDM: true,
  params: "[confirm]",
  slashOptions: [{ name: "confirm", type: "boolean" }],
  async run(params, message) {
    const isFluxer = message instanceof FluxerMessage;
    const userType = isFluxer ? "fluxer" : "discord";

    if (await isUserOptedOut(userType, message.author.id)) {
      await message.reply("You are already opted out of bridging.");
      return;
    }

    if (params[0]?.toLowerCase() !== "confirm") {
      const prefix = await getGuildPrefix(message.guildId ?? "");
      const otherSide = isFluxer ? "Discord" : "Fluxer";
      const platform = isFluxer ? "Fluxer" : "Discord";
      const communityType = isFluxer ? "community" : "server";

      await message.reply({
        embeds: [
          {
            title: "Opting out of Fluxcord bridging",
            description:
              `**Opting out is global.** This will stop your new messages from being bridged to ${otherSide} on every ${communityType}, not just this one.\n\n` +
              "Before continuing, note that:\n" +
              `- New messages will no longer be bridged to ${otherSide}.\n` +
              `- Replies to your messages will show an *Unbridged message* on ${otherSide}. Author information nor message content will not be visible.\n` +
              `- Forum threads you create will still have it's thread title visible but your message will not be bridged.\n` +
              "- Already bridged messages will stay, but edits will no longer be bridged. Deletions will be bridged regardless.\n" +
              `- This only affects your current account on ${platform}. You need to run this again on the other side.\n` +
              "- **This will not apply on voice bridges.**\n\n" +
              `To confirm, run \`${prefix}user opt-out confirm\`. To undo this later, run \`${prefix}opt-in\`.`,
          },
        ],
      });
      return;
    }

    await setUserOptedOut(userType, message.author.id, true);

    await message.reply("Done. Your messages will no longer be bridged globally.");
  },
};

export default command;
