import { Message as FluxerMessage } from "@fluxerjs/core";
import { applyBridgeValue } from "../utils/BridgeToggle.js";

const USAGE =
  "Usage: `off`, `full` (`[Discord]`/`[Fluxer]`) or `short` (`[D]`/`[F]`).";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "nameindicator",
  aliases: ["indicator"],
  description: "Show where a bridged name came from",
  requireElevated: true,
  params: "[off|full|short]",
  slashOptions: [
    {
      name: "mode",
      type: "string",
      choices: [
        { name: "off", value: "off" },
        { name: "full", value: "full" },
        { name: "short", value: "short" },
      ],
    },
  ],
  async run(params, message) {
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }

    const isFluxer = message instanceof FluxerMessage;
    const arg = params[0]?.toLowerCase();

    if (arg && !["off", "full", "short"].includes(arg)) {
      await message.reply(USAGE);
      return;
    }

    const { current, changed } = await applyBridgeValue(
      message.guildId,
      isFluxer ? "fluxer" : "discord",
      "nameIndicator",
      arg,
      "off",
    );

    if (!arg) {
      await message.reply(
        `Name indicator is currently set to \`${current}\`.\n${USAGE}`,
      );
      return;
    }

    if (!changed) {
      await message.reply(`Name indicator is already set to \`${current}\`.`);
      return;
    }

    await message.reply(`Name indicator set to \`${arg}\`.`);
  },
};

export default command;
