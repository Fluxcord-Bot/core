import {
  Sequelize,
  Model,
  Column,
  DataType,
  Table,
  HasMany,
  BelongsTo,
  ForeignKey,
  Default,
  AllowNull,
} from "sequelize-typescript";
import Config from "../config";
import { log } from "../utils/Logger";
import fs from "node:fs";

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

@Table
export class MessageMap extends Model {
  @AllowNull(false)
  @Column(DataType.ENUM("discord", "fluxer"))
  declare messageSource: "discord" | "fluxer";

  @AllowNull(false)
  @Column(DataType.STRING)
  declare discordMessageId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare fluxerMessageId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare authorId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare content: string;

  @ForeignKey(() => ChannelMap)
  @Column({ type: DataType.INTEGER, field: "ChannelMapId" })
  declare channelMapId: number;

  @BelongsTo(() => ChannelMap)
  declare channelMap: ChannelMap;
}

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: Config.DataFolderPath + "/fluxcord.db",
  logging: (msg) => log("DB", msg),
  models: [ChannelMap, MessageMap],
});

await sequelize.sync();

export { sequelize };
