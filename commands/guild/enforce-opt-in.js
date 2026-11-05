import { Message as FluxerMessage } from "@fluxerjs/core";
import { applyBridgeToggle, getBridgeGuildMaps } from "../../utils/BridgeToggle.js";
import { notifyExistingOptOutMembers } from "../../utils/UserOptOut.js";

/**
 * @type {import('../../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  groupNames: ["guild", "g", "server", "s", "community", "c"],
  name: "enforce-opt-in",
  aliases: ["enforce-optin", "enforceoptin"],
  description: "Require globally opted-out members to opt in to bridging in this server/community",
  requireElevated: true,
  params: "[on|off]",
  slashOptions: [
    {
      name: "state",
      type: "string",
      choices: [
        { name: "on", value: "on" },
        { name: "off", value: "off" },
      ],
    },
  ],
  async run(params, message, discordClient, fluxerClient) {
    const community = message instanceof FluxerMessage ? "community" : "server";
    if (!message.guildId) {
      await message.reply(`This command can only be used in a ${community}.`);
      return;
    }

    const guildType = message instanceof FluxerMessage ? "fluxer" : "discord";
    const arg = params[0]?.toLowerCase();
    let requested;
    if (arg === "on") {
      requested = true;
    } else if (arg === "off") {
      requested = false;
    } else if (arg) {
      await message.reply("Usage: `on` or `off`.");
      return;
    }

    const { enabled, changed } = await applyBridgeToggle(message.guildId, guildType, "guildOptInEnabled", requested);

    if (!changed) {
      await message.reply(`Opt-in enforcement is already ${enabled ? "enabled" : "disabled"} for this ${community}.`);
      return;
    }

    if (!enabled) {
      await message.reply(`Opt-in enforcement is disabled. Global opt-outs will apply normally in this ${community}.`);
      return;
    }

    const guildMaps = await getBridgeGuildMaps(message.guildId, guildType);
    let sent = 0;
    let failed = 0;
    for (const guildMap of guildMaps) {
      const result = await notifyExistingOptOutMembers(guildMap.guildId, guildMap.guildType, discordClient, fluxerClient);
      sent += result.sent;
      failed += result.failed;
    }

    await message.reply(
      `Opt-in enforcement is enabled for this ${community}. Sent ${sent} prompt${sent === 1 ? "" : "s"} to existing globally opted-out members.` +
        (failed > 0 ? ` ${failed} notification attempt${failed === 1 ? "" : "s"} failed; see the bot logs.` : "")
    );
  },
};

export default command;
