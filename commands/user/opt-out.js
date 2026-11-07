import { Message as FluxerMessage } from "@fluxerjs/core";
import { getGuildPrefix } from "../../utils/GetGuildPrefix.js";
import { isGuildOptInEnabled, isUserOptedOut, setGuildOptInState, setUserOptedOut } from "../../utils/UserOptOut.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["user", "u"],
  name: "opt-out",
  aliases: ["optout"],
  topLevelAliases: ["optout", "opt-out"],
  description: "Stop bridging globally or in this guild/community only",
  requireElevated: false,
  params: "[global] [confirm]",
  slashOptions: [
    {
      name: "scope",
      type: "string",
      choices: [{ name: "global", value: "global" }],
    },
    { name: "confirm", type: "boolean" },
  ],
  async run(params, message) {
    const isFluxer = message instanceof FluxerMessage;
    const userType = isFluxer ? "fluxer" : "discord";
    const scope = params.find(param => param.toLowerCase() !== "confirm")?.toLowerCase();
    const confirmed = params.some(param => param.toLowerCase() === "confirm");
    const community = isFluxer ? "community" : "guild";
    const otherSide = isFluxer ? "Discord" : "Fluxer";
    const platform = isFluxer ? "Fluxer" : "Discord";

    if (scope && scope !== "global") {
      await message.reply(`Usage: \`user opt-out\` for this ${community} only, or \`user opt-out global\` to stop bridging globally.`);
      return;
    }

    if (scope !== "global") {
      if (!message.guildId) {
        await message.reply(`Fluxcord commands cannot be used in DMs. Run \`user opt-out\` in the ${community}.`);
        return;
      }

      if (await isGuildOptInEnabled(message.guildId, userType)) {
        await message.reply(`This ${community} requires opt-in, so per-${community} opt-out is unavailable here.`);
        return;
      }

      if (!confirmed) {
        const prefix = await getGuildPrefix(message.guildId ?? "");
        await message.reply(
          {
            embeds: [
              {
                title: `Opting out of Fluxcord bridging in this ${community}`,
                description:
                  `This will stop your new messages from being bridged to ${otherSide} in this ${community} only.\n\n` +
                  "Before continuing, note that:\n" +
                  `- Replies to your messages will show an *Unbridged message* on ${otherSide}. Your author information and message content won't be visible.\n` +
                  `- Forum threads you create will still show their title, but your message won't be bridged.\n` +
                  "- Already bridged messages will stay, but edits won't be bridged. Deletions will be bridged regardless.\n" +
                  `- This only affects your current account on ${platform}; it won't change your global preference or other ${community === "community" ? "communities" : "guilds"}.\n` +
                  "- **This will not apply on voice bridges.**\n\n" +
                  `To confirm, run \`${prefix}user opt-out confirm\` in this ${community}.`,
              },
            ],
          }
        );
        return;
      }

      await setGuildOptInState(userType, message.guildId, message.author.id, false);
      await message.reply(`Done. Your messages will no longer be bridged in that ${community}; your global preference is unchanged.`);
      return;
    }

    if (await isUserOptedOut(userType, message.author.id)) {
      await message.reply("You are already opted out of bridging.");
      return;
    }

    if (!confirmed) {
      const prefix = await getGuildPrefix(message.guildId ?? "");
      await message.reply({
        embeds: [
          {
            title: "Opting out of Fluxcord bridging",
            description:
              `**Opting out is global.** This will stop your new messages from being bridged to ${otherSide} on every ${community}, not just this one.\n\n` +
              "Before continuing, note that:\n" +
              `- New messages will no longer be bridged to ${otherSide}.\n` +
              `- Replies to your messages will show an *Unbridged message* on ${otherSide}. Author information nor message content will not be visible.\n` +
              `- Forum threads you create will still have it's thread title visible but your message will not be bridged.\n` +
              "- Already bridged messages will stay, but edits will no longer be bridged. Deletions will be bridged regardless.\n" +
              `- This only affects your current account on ${platform}. You need to run this again on the other side.\n` +
              "- **This will not apply on voice bridges.**\n\n" +
              `To confirm, run \`${prefix}user opt-out global confirm\`. To undo this later, run \`${prefix}opt-in global\`.`,
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
