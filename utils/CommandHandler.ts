import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
} from "discord.js";
import {
  Message as FluxerMessage,
  Client as FluxerClient,
  EmbedBuilder,
} from "@fluxerjs/core";
import Config from "../config";
import fs from "node:fs";
import ExpiryMap from "expiry-map";
import type { CommandSchema } from "./CommandSchema";
import { checkManageServerPerms } from "./CheckManageServerPerms";
import { log } from "./Logger";

export let BridgeMap: ExpiryMap<
  string,
  {
    discordChannel: string;
    fluxerChannel: string;
    bridgeType: string;
  }
> = new ExpiryMap(120000);

async function getCommands() {
  const entries = fs.readdirSync("./commands");
  return Promise.all(
    entries.flatMap(
      async (x) => (await import("../commands/" + x)).default as CommandSchema,
    ),
  );
}

export const commands = await getCommands();

export async function CommandHandler(
  message: FluxerMessage | OmitPartialGroupDMChannel<DiscordMessage<boolean>>,
  discordClient: DiscordClient,
  fluxerClient: FluxerClient,
) {
  if (message.author.bot || message.webhookId) return;

  const cmdList = message.content.split(" ");
  const command = cmdList[0]?.replace(Config.BotPrefix, "");
  const params = cmdList.slice(1);
  const commandToRun = commands.find((x) => x.name === command);

  if (!commandToRun) {
    await message.reply(
      `Command \`${Config.BotPrefix + command}\` does not exist!`,
    );
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
  }

  if (
    commandToRun?.requireOwner &&
    !Config.AdminAccountIds.find((x) => x === message.author.id)
  ) {
    await message.reply(`Only bot admins can execute this command!`);
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
