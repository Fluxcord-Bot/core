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
  name: string;
  description: string;
  requireElevated: boolean;
  requireOwner?: boolean;
  params?: string;
  additionalInfo?: string;
  run: (
    params: string[],
    message: OmitPartialGroupDMChannel<DiscordMessage<boolean>> | FluxerMessage,
    discordClient: DiscordClient,
    fluxerClient: FluxerClient,
  ) => Promise<void>;
};
