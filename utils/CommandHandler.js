import { Message as FluxerMessage, EmbedBuilder } from "@fluxerjs/core";
import Config from "../utils/ConfigHandler.js";
import fs from "node:fs";
import ExpiryMap from "expiry-map";
import { checkManageServerPerms } from "./CheckManageServerPerms.js";
import { log } from "./Logger.js";
import { sanitizePings } from "./SanitizePings.js";

export let BridgeMap = new ExpiryMap(120000);
/**
 * @type {ExpiryMap<string, {
 *  guildId: string,
 *  channelId: string,
 *  isFluxer: boolean,
 *  direction: "f2d" | "d2f" | "both"
 * }>}
 */
export let PendingSetup = new ExpiryMap(300000);

/**
 * @returns {Promise<import('./CommandSchema.d.ts').CommandSchema[]>}
 */
export async function getCommands() {
  const entries = fs.readdirSync("./commands", {
    recursive: true,
  });
  return Promise.all(
    entries
      .filter((x) => fs.statSync("./commands/" + x).isFile)
      .flatMap(async (x) => (await import("../commands/" + x)).default),
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
  const commands = await getCommands();
  let commandToRun = commands.find(
    (x) => x.name === command || x.aliases?.find((y) => y === command),
  );

  let isGrouped = false;

  if (!commandToRun) {
    // check if it's a group command
    const commandGroup = commands.filter((x) =>
      x.groupNames?.find((y) => y === command),
    );

    if (commandGroup.length > 0) {
      const command = cmdList[1];
      commandToRun = commands.find(
        (x) => x.name === command || x.aliases?.find((y) => y === command),
      );
      isGrouped = true;
    } else {
      await message.reply({
        embeds: [
          {
            description: `Command \`${Config.BotPrefix + command}\` does not exist!`,
            color: 0xef0000,
          },
        ],
        allowedMentions: {
          roles: [],
          users: [],
          repliedUser: true,
        },
      });
      return;
    }
  }

  const params = cmdList.slice(isGrouped ? 2 : 1);

  if (
    commandToRun?.requireElevated &&
    !(await checkManageServerPerms(
      message.guildId ?? "",
      message.author.id,
      message.client,
    ))
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
