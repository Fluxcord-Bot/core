import { Sequelize } from "sequelize-typescript";
import Config from "../utils/ConfigHandler.js";
import { log } from "../utils/Logger.js";
import { DataTypes, Model } from "sequelize";

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: Config.DataFolderPath + "/fluxcord.db",
  logging: (msg) => log("DB", msg),
});

class ChannelMap extends Model {}
class MessageMap extends Model {}
class UserConfig extends Model {}

ChannelMap.init(
  {
    discordGuildId: { type: DataTypes.STRING, allowNull: false },
    discordChannelId: { type: DataTypes.STRING, allowNull: false },
    discordWebhookId: { type: DataTypes.STRING, allowNull: false },
    discordWebhookToken: { type: DataTypes.STRING, allowNull: false },
    fluxerGuildId: { type: DataTypes.STRING, allowNull: false },
    fluxerChannelId: { type: DataTypes.STRING, allowNull: false },
    fluxerWebhookId: { type: DataTypes.STRING, allowNull: false },
    fluxerWebhookToken: { type: DataTypes.STRING, allowNull: false },
    errorLoggingChannelId: { type: DataTypes.STRING, allowNull: true },
    errorLoggingPlatform: {
      type: DataTypes.ENUM("fluxer", "discord"),
      allowNull: true,
    },
    bridgeType: {
      type: DataTypes.ENUM("discord2fluxer", "fluxer2discord", "both"),
      allowNull: false,
      defaultValue: "both",
    },
  },
  { sequelize, modelName: "ChannelMap" },
);

MessageMap.init(
  {
    messageSource: {
      type: DataTypes.ENUM("discord", "fluxer"),
      allowNull: false,
    },
    discordMessageId: { type: DataTypes.STRING, allowNull: false },
    fluxerMessageId: { type: DataTypes.STRING, allowNull: false },
    authorId: { type: DataTypes.STRING, allowNull: false },
    content: { type: DataTypes.STRING, allowNull: false },
    channelMapId: {
      type: DataTypes.INTEGER,
      field: "ChannelMapId",
      references: { model: ChannelMap, key: "id" },
    },
  },
  { sequelize, modelName: "MessageMap" },
);

UserConfig.init(
  {
    userType: { type: DataTypes.ENUM("discord", "fluxer"), allowNull: false },
    userId: { type: DataTypes.STRING, allowNull: false },
    proxyCompatibility: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    doNotBridgePrefix: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
  },
  { sequelize, modelName: "UserConfig" },
);

MessageMap.belongsTo(ChannelMap, {
  foreignKey: "channelMapId",
  as: "channelMap",
});
ChannelMap.hasMany(MessageMap, {
  foreignKey: "channelMapId",
  as: "messageMaps",
});

export { sequelize, ChannelMap, MessageMap, UserConfig };
