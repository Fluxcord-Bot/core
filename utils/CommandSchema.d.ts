import {
  type OmitPartialGroupDMChannel,
  Message as DiscordMessage,
  Client as DiscordClient,
  User as DiscordUser,
} from "discord.js";
import {
  Message as FluxerMessage,
  Client as FluxerClient,
} from "@fluxerjs/core";

export type SlashOptionDef = {
  name: string;
  type?: "string" | "integer" | "boolean" | "channel" | "attachment";
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  flag?: string;
  rest?: boolean;
  channelTypes?: number[];
};

export type SlashShimMessage = {
  author: DiscordUser;
  member: any;
  content: string;
  guildId: string | null;
  channelId: string;
  channel: any;
  guild: any;
  client: DiscordClient;
  createdTimestamp: number;
  reference: null;
  interaction: null;
  reply: (payload: any) => Promise<any>;
};

export type CommandSchema = {
  groupNames?: string[];
  name: string;
  aliases?: string[];
  topLevelAliases?: string[];
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
    message:
      | OmitPartialGroupDMChannel<DiscordMessage<boolean>>
      | FluxerMessage
      | SlashShimMessage,
    discordClient: DiscordClient,
    fluxerClient: FluxerClient,
  ) => Promise<void>;
};
