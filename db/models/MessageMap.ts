import {
  Table,
  AllowNull,
  Column,
  DataType,
  ForeignKey,
  Model,
  BelongsTo,
} from "sequelize-typescript";
import { ChannelMap } from "./ChannelMap";

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
