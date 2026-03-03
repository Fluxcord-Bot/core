import { Message as FluxerMessage, EmbedBuilder } from "@fluxerjs/core";
import Config from "../utils/ConfigHandler.js";
import fs from "node:fs";
import ExpiryMap from "expiry-map";
import { checkManageServerPerms } from "./CheckManageServerPerms.js";
import { log } from "./Logger.js";

export let BridgeMap = new ExpiryMap(120000);

export async function getCommands() {
  const entries = fs.readdirSync("./commands");
  return Promise.all(
    entries.flatMap(async (x) => (await import("../commands/" + x)).default),
  );
}

/**
 * @param {import("@fluxerjs/core").Message | import("discord.js").OmitPartialGroupDMChannel<import("discord.js").Message<boolean>>} message
 * @param {DiscordClient} discordClient
 * @param {FluxerClient} fluxerClient
 */
export async function CommandHandler(message, discordClient, fluxerClient) {
  if (message.author.bot || message.webhookId) return;

  const cmdList = message.content.split(" ");
  const command = cmdList[0]?.replace(Config.BotPrefix, "");
  const params = cmdList.slice(1);
  const commandToRun = (await getCommands()).find((x) => x.name === command);

  if (!commandToRun) {
    await message.reply(
      `Command \`${Config.BotPrefix + command}\` does not exist!`,
    );
    return;
  }

  if (
    commandToRun?.requireElevated &&
    !checkManageServerPerms(
      message.guildId ?? "",
      message.author.id,
      message.client,
    )
  ) {
    await message.reply(
      `You need at least **Manage ${message instanceof FluxerMessage ? "Community" : "Server"}** permissions to run this command!`,
    );
    return;
  }

  if (
    commandToRun?.requireOwner &&
    !Config.AdminAccountIds.find((x) => x === message.author.id)
  ) {
    await message.reply(`Only bot admins can execute this command!`);
    return;
  }

  try {
    await commandToRun?.run(params, message, discordClient, fluxerClient);
  } catch (e) {
    await message.reply({
      // @ts-expect-error
      embeds: [
        new EmbedBuilder()
          .setTitle("A error has occurred while executing this command!")
          .setDescription(
            "Please ping <@1471779547901222947> on https://fluxer.gg/6ULDiF2g showing this error.",
          )
          .addFields({
            name: "Stack trace",
            value: `${e}`,
          }),
      ],
    });

    log("DEBUG", e);
  }
}
