import { Client, EmbedBuilder } from "@fluxerjs/core";
import Config from "../config.js";
import { ChannelMap } from "../db/index.js";
import Package from "../package.json" with { type: "json" };
import getCommitHash from "../utils/GetCommitHash.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import ForkDetails from "../utils/Fork.js";
import DefaultConfig from "../utils/ConfigHandler.js";

/**
 * @type {import('../utils/CommandSchema.d.ts').CommandSchema}
 */
const command = {
  name: "about",
  description: "About Fluxcord",
  requireElevated: false,
  async run(params, message, discordClient, fluxerClient) {
    const channels = await ChannelMap.findAll();

    const container = new ContainerBuilder({
      accent_color: 0x5865f2,
    })
      .addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder()
              .setContent(`## ${ForkDetails.isFork ? `${ForkDetails.forkName} ${ForkDetails.forkVersion}` : `Fluxcord ${Package.version}`}
Fluxcord is a simple, set-and-forget Discord <-> Fluxer bridge.${ForkDetails.isFork && !!ForkDetails.forkDescription ? "\n" + ForkDetails.forkDescription : ""}

-# Currently bridging ${channels.length} channel${channels.length === 1 ? "" : "s"}`),
          )
          .setThumbnailAccessory(
            new ThumbnailBuilder()
              .setDescription("Fluxcord logo")
              .setURL("https://party.jbc.lol/fluxcord.png"),
          ),
      )
      .addSeparatorComponents((seperator) => seperator)
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Source code")
            .setURL(
              ForkDetails.isFork
                ? ForkDetails.forkRepo
                : "https://git.gay/Fluxcord/core",
            ),
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Voice bridge source")
            .setURL(
              ForkDetails.isFork && ForkDetails.forkVoiceRepo
                ? ForkDetails.forkVoiceRepo
                : "https://git.gay/Fluxcord/voice",
            ),
        ),
        ...(!ForkDetails.isFork || ForkDetails.forkEnableSupport
          ? [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setStyle(ButtonStyle.Link)
                  .setLabel("Support Fluxer community")
                  .setURL("https://fluxer.gg/jbcrn"),
                new ButtonBuilder()
                  .setStyle(ButtonStyle.Link)
                  .setLabel("Discord server")
                  .setURL("https://discord.gg/NXA2Ffc3Am"),
              ),
            ]
          : []),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Terms of Service")
            .setURL("https://fluxcord.jbcrn.dev/terms"),
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Privacy policy")
            .setURL("https://fluxcord.jbcrn.dev/privacy"),
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder({
          content:
            "-# " +
            `Commit hash ${getCommitHash()}${ForkDetails.isFork ? ", Based on Fluxcord " + Package.version : ""}${DefaultConfig.EmbedFooterContent ? " - " + DefaultConfig.EmbedFooterContent : ""}`,
        }),
      );
    await message.reply({
      //@ts-expect-error

      ...(!(message.client instanceof Client)
        ? {
            components: [container],
            flags: MessageFlags.IsComponentsV2,
          }
        : {
            embeds: [
              new EmbedBuilder()
                .setTitle(
                  ForkDetails.isFork
                    ? `${ForkDetails.forkName} ${ForkDetails.forkVersion}`
                    : `Fluxcord ${Package.version}`,
                )
                .setThumbnail("https://party.jbc.lol/fluxcord.png")
                .setDescription(
                  `Fluxcord is a simple, set-and-forget Discord <-> Fluxer bridge.${ForkDetails.isFork && !!ForkDetails.forkDescription ? "\n" + ForkDetails.forkDescription : ""}` +
                    (message.client instanceof Client
                      ? `\n\n[Source code](${
                          ForkDetails.isFork
                            ? ForkDetails.forkRepo
                            : "https://git.gay/Fluxcord/core"
                        }) - [Voice bridge source code](${
                          ForkDetails.isFork && ForkDetails.forkVoiceRepo
                            ? ForkDetails.forkVoiceRepo
                            : "https://git.gay/Fluxcord/voice"
                        })\n` +
                        (!ForkDetails.isFork || ForkDetails.forkEnableSupport
                          ? "[Support Fluxer community](https://fluxer.gg/jbcrn) - [Support Discord server](https://discord.gg/NXA2Ffc3Am)\n"
                          : "") +
                        "[Terms of Service](https://fluxcord.jbcrn.dev/terms) - [Privacy policy](https://fluxcord.jbcrn.dev/privacy)\n"
                      : ""),
                )
                .setFooter(
                  Config.EmbedFooterContent
                    ? {
                        text:
                          `Commit hash ${getCommitHash()}${ForkDetails.isFork ? ", Based on Fluxcord " + Package.version : ""} - Currently bridging ${channels.length} channel${channels.length === 1 ? "" : "s"} - ` +
                          Config.EmbedFooterContent,
                      }
                    : `Commit hash ${getCommitHash()}${ForkDetails.isFork ? ", Based on Fluxcord " + Package.version : ""} - Currently bridging ${channels.length} channel${channels.length === 1 ? "" : "s"}`,
                ),
            ],
          }),
    });
  },
};

export default command;
