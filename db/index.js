import { Sequelize } from "sequelize-typescript";
import Config from "../utils/ConfigHandler.js";
import { log } from "../utils/Logger.js";
import { DataTypes, Model } from "sequelize";
import DefaultConfig from "../utils/ConfigHandler.js";
import sqlite3 from "@journeyapps/sqlcipher";

export const isPostgres = !!Config.PostgresConnectionString && Config.PostgresConnectionString.length > 0;

/** @type {import("sequelize").Sequelize} */
let sequelize;

if (isPostgres) {
  if (DefaultConfig.DatabaseEncryptionToken) {
    console.warn(
      "[DB] DatabaseEncryptionToken is set but PostgresConnectionString is also set. The encryption token is ignored in Postgres mode."
    );
  }
  sequelize = new Sequelize(Config.PostgresConnectionString, {
    dialect: "postgres",
    logging: msg => log("DB", msg),
  });
  await sequelize.query("SELECT 1;");
} else {
  sequelize = new Sequelize({
    dialect: "sqlite",
    dialectModule: sqlite3,
    storage: Config.DataFolderPath + "/fluxcord.db",
    logging: msg => log("DB", msg),
    password: !!DefaultConfig.DatabaseEncryptionToken ? DefaultConfig.DatabaseEncryptionToken : undefined,
  });

  if (DefaultConfig.DatabaseEncryptionToken) {
    await sequelize.query("PRAGMA cipher_compatibility = 4;");
    await sequelize.query(`PRAGMA key = ${sequelize.escape(Config.DatabaseEncryptionToken)};`);
  }

  await sequelize.query("PRAGMA wal_checkpoint(TRUNCATE);");
  await sequelize.query("VACUUM;");
}

class GuildMap extends Model {}
class UserConfig extends Model {}
class GuildUserOptIn extends Model {}
class BridgeGroup extends Model {}
class BridgeEndpoint extends Model {}
class MessageLink extends Model {}
class VoiceChannelMap extends Model {}

GuildMap.init(
  {
    guildId: { type: DataTypes.STRING, allowNull: false },
    guildType: { type: DataTypes.ENUM("fluxer", "discord"), allowNull: false },
    fluxerInstanceId: { type: DataTypes.STRING, allowNull: false, defaultValue: "default" },
    errorReaction: {
      type: DataTypes.STRING,
      defaultValue: "⛓️‍💥",
      allowNull: true,
    },
    infoReactionEmoji: { type: DataTypes.STRING, allowNull: true },
    errorLoggingChannelId: { type: DataTypes.STRING, allowNull: true },
    errorLoggingPlatform: {
      type: DataTypes.ENUM("fluxer", "discord"),
      allowNull: true,
    },
    botPrefix: {
      type: DataTypes.STRING,
      defaultValue: DefaultConfig.BotPrefix,
    },
    typingEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    inviteEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    everyonePingEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    guildOptInEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    autoPublishEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    nameIndicator: {
      type: DataTypes.ENUM("off", "full", "short"),
      allowNull: false,
      defaultValue: "off",
    },
    customBio: { type: DataTypes.STRING, allowNull: true },
  },
  { sequelize, modelName: "GuildMap" }
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
  { sequelize, modelName: "UserConfig" }
);

GuildUserOptIn.init(
  {
    guildType: { type: DataTypes.ENUM("discord", "fluxer"), allowNull: false },
    guildId: { type: DataTypes.STRING, allowNull: false },
    userId: { type: DataTypes.STRING, allowNull: false },
    optedIn: { type: DataTypes.BOOLEAN, allowNull: false },
    prompted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    sequelize,
    modelName: "GuildUserOptIn",
    indexes: [{ unique: true, fields: ["guildType", "guildId", "userId"] }],
  }
);

BridgeGroup.init(
  {
    bridgeType: {
      type: DataTypes.ENUM("discord2fluxer", "fluxer2discord", "both"),
      allowNull: false,
      defaultValue: "both",
    },
  },
  { sequelize, modelName: "BridgeGroup" }
);
BridgeEndpoint.init(
  {
    platform: { type: DataTypes.ENUM("discord", "fluxer"), allowNull: false },
    instanceId: { type: DataTypes.STRING, allowNull: false, defaultValue: "default" },
    channelId: { type: DataTypes.STRING, allowNull: false },
    guildId: { type: DataTypes.STRING, allowNull: false },
    webhookId: { type: DataTypes.STRING, allowNull: true },
    webhookToken: { type: DataTypes.STRING, allowNull: true },
    kind: { type: DataTypes.ENUM("channel", "thread"), allowNull: false, defaultValue: "channel" },
    autoMirrored: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    parentEndpointId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
      field: "ParentBridgeEndpointId",
      references: { model: BridgeEndpoint, key: "id" },
    },
    tagMap: { type: DataTypes.JSON, allowNull: true },
    groupId: {
      type: DataTypes.INTEGER,
      field: "BridgeGroupId",
      references: { model: BridgeGroup, key: "id" },
    },
  },
  {
    sequelize,
    modelName: "BridgeEndpoint",
    indexes: [
      { fields: ["platform", "channelId"] },
      { fields: ["BridgeGroupId"] },
      { fields: ["platform", "guildId"] },
    ],
  }
);
MessageLink.init(
  {
    linkGroup: { type: DataTypes.STRING, allowNull: false },
    messageId: { type: DataTypes.STRING, allowNull: false },
    replyId: { type: DataTypes.STRING, allowNull: true },
    authorId: { type: DataTypes.STRING, allowNull: true },
    endpointId: {
      type: DataTypes.INTEGER,
      field: "BridgeEndpointId",
      references: { model: BridgeEndpoint, key: "id" },
    },
  },
  {
    sequelize,
    modelName: "MessageLink",
    indexes: [
      { fields: ["BridgeEndpointId", "messageId"] },
      { fields: ["linkGroup"] },
      { fields: ["messageId"] },
    ],
  }
);

VoiceChannelMap.init(
  {
    discordGuildId: { type: DataTypes.STRING, allowNull: false },
    discordChannelId: { type: DataTypes.STRING, allowNull: false },
    fluxerGuildId: { type: DataTypes.STRING, allowNull: false },
    fluxerChannelId: { type: DataTypes.STRING, allowNull: false },
    fluxerInstanceId: { type: DataTypes.STRING, allowNull: false, defaultValue: "default" },
  },
  { sequelize, modelName: "VoiceChannelMap" }
);

MessageLink.belongsTo(BridgeEndpoint, {
  foreignKey: "endpointId",
  as: "endpoint",
});
BridgeEndpoint.hasMany(MessageLink, {
  foreignKey: "endpointId",
  as: "messageLinks",
});
BridgeEndpoint.belongsTo(BridgeGroup, {
  foreignKey: "groupId",
  as: "group",
});
BridgeGroup.hasMany(BridgeEndpoint, {
  foreignKey: "groupId",
  as: "endpoints",
});
BridgeEndpoint.belongsTo(BridgeEndpoint, {
  foreignKey: "parentEndpointId",
  as: "parentEndpoint",
});

export {
  sequelize,
  GuildMap,
  UserConfig,
  GuildUserOptIn,
  BridgeGroup,
  BridgeEndpoint,
  MessageLink,
  VoiceChannelMap,
};
