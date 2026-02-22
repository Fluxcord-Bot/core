import { Table, AllowNull, Column, DataType, Default, Model } from "sequelize-typescript";

@Table
export class UserConfig extends Model {
  @AllowNull(false)
  @Column(DataType.ENUM("discord", "fluxer"))
  declare userType: "discord" | "fluxer";

  @AllowNull(false)
  @Column(DataType.STRING)
  declare userId: string;

  @AllowNull(false)
  @Default(false)
  @Column(DataType.BOOLEAN)
  declare proxyCompatibility: boolean;

  @AllowNull(true)
  @Default(null)
  @Column(DataType.STRING)
  declare doNotBridgePrefix: string | null;
}