import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
} from "discord.js";
import {
  Message as FluxerMessage,
  Client as FluxerClient,
} from "@fluxerjs/core";

export type SlashOptionDef = {
  name: string;
  type?: "string" | "integer" | "boolean" | "channel";
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  flag?: string;
  rest?: boolean;
  channelTypes?: number[];
};

export type CommandSchema = {
  groupNames?: string[];
  name: string;
  aliases?: string[];
  description: string;
  requireElevated: boolean;
  requireOwner?: boolean;
  hideFromHelp?: boolean;
  params?: string;
  slashOptions?: SlashOptionDef[];
  allowDM?: boolean;
  excludeFromSlash?: boolean;
  additionalInfo?: string;
  run: (
    params: string[],
    message: OmitPartialGroupDMChannel<DiscordMessage<boolean>> | FluxerMessage,
    discordClient: DiscordClient,
    fluxerClient: FluxerClient,
  ) => Promise<void>;
};
