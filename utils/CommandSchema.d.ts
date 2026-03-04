import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
} from "discord.js";
import {
  Message as FluxerMessage,
  Client as FluxerClient,
} from "@fluxerjs/core";

export type CommandSchema = {
  groupNames?: string[];
  name: string;
  aliases?: string[];
  description: string;
  requireElevated: boolean;
  requireOwner?: boolean;
  hideFromHelp?: boolean;
  params?: string;
  additionalInfo?: string;
  run: (
    params: string[],
    message: OmitPartialGroupDMChannel<DiscordMessage<boolean>> | FluxerMessage,
    discordClient: DiscordClient,
    fluxerClient: FluxerClient,
  ) => Promise<void>;
};
