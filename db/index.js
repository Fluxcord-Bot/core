import { Sequelize } from "sequelize-typescript";
import Config from "../utils/ConfigHandler.js";
import { log } from "../utils/Logger.js";
import { DataTypes, Model } from "sequelize";
import DefaultConfig from "../utils/ConfigHandler.js";

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: Config.DataFolderPath + "/fluxcord.db",
  logging: (msg) => log("DB", msg),
});

class ChannelMap extends Model { }
class MessageMap extends Model { }
class UserConfig extends Model { }
class GuildMap extends Model { }

GuildMap.init(
  {
    guildId: { type: DataTypes.STRING, allowNull: false },
    guildType: { type: DataTypes.ENUM("fluxer", "discord"), allowNull: false },
    errorReaction: {
      type: DataTypes.STRING,
      defaultValue: "⛓️‍💥",
      allowNull: true,
    },
    errorLoggingChannelId: { type: DataTypes.STRING, allowNull: true },
    errorLoggingPlatform: {
      type: DataTypes.ENUM("fluxer", "discord"),
      allowNull: true,
    },
    botPrefix: {
      type: DataTypes.STRING,
      defaultValue: DefaultConfig.BotPrefix,
    },
  },
  { sequelize, modelName: "GuildMap" },
);

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
    bridgeType: {
      type: DataTypes.ENUM("discord2fluxer", "fluxer2discord", "both"),
      allowNull: false,
      defaultValue: "both",
    },
    fluxerGuildMapId: {
      type: DataTypes.INTEGER,
      field: "FluxerGuildMapId",
      references: { model: GuildMap, key: "id" },
    },
    discordGuildMapId: {
      type: DataTypes.INTEGER,
      field: "DiscordGuildMapId",
      references: { model: GuildMap, key: "id" },
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
    discordReplyId: { type: DataTypes.STRING, allowNull: false },
    fluxerReplyId: { type: DataTypes.STRING, allowNull: false },
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
ChannelMap.belongsTo(GuildMap, {
  foreignKey: "discordGuildMapId",
  as: "discordGuildMap",
});
ChannelMap.belongsTo(GuildMap, {
  foreignKey: "fluxerGuildMapId",
  as: "fluxerGuildMap",
});
GuildMap.hasMany(ChannelMap, {
  foreignKey: "discordGuildMapId",
  as: "discordChannelMaps",
});
GuildMap.hasMany(ChannelMap, {
  foreignKey: "fluxerGuildMapId",
  as: "fluxerChannelMaps",
});

export { sequelize, ChannelMap, MessageMap, UserConfig, GuildMap };
