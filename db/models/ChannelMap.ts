import {
  Table,
  AllowNull,
  Column,
  DataType,
  Default,
  Model,
  HasMany,
} from "sequelize-typescript";
import { MessageMap } from "./MessageMap";

@Table
export class ChannelMap extends Model {
  @AllowNull(false)
  @Column(DataType.STRING)
  declare discordGuildId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare discordChannelId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare discordWebhookId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare discordWebhookToken: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare fluxerGuildId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare fluxerChannelId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare fluxerWebhookId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare fluxerWebhookToken: string;

  @AllowNull(false)
  @Default("both")
  @Column(DataType.ENUM("discord2fluxer", "fluxer2discord", "both"))
  declare bridgeType: "discord2fluxer" | "fluxer2discord" | "both";

  @HasMany(() => MessageMap)
  declare messageMaps: MessageMap[];
}
