import { DataTypes, QueryInterface } from "sequelize";
import DefaultConfig from "../utils/ConfigHandler.js";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.createTable("GuildMaps", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
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
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  const isPostgres = queryInterface.sequelize.getDialect() === "postgres";
  const discordGuildType = isPostgres
    ? `'discord'::"enum_GuildMaps_guildType"`
    : `'discord'`;
  const fluxerGuildType = isPostgres
    ? `'fluxer'::"enum_GuildMaps_guildType"`
    : `'fluxer'`;
  const errorLoggingPlatform = isPostgres
    ? `"errorLoggingPlatform"::text::"enum_GuildMaps_errorLoggingPlatform"`
    : `"errorLoggingPlatform"`;
  const discordComparison = isPostgres
    ? `"guildType" = 'discord'::"enum_GuildMaps_guildType"`
    : `"guildType" = 'discord'`;
  const fluxerComparison = isPostgres
    ? `"guildType" = 'fluxer'::"enum_GuildMaps_guildType"`
    : `"guildType" = 'fluxer'`;
  await queryInterface.sequelize.query(`
    INSERT INTO "GuildMaps" ("guildId", "guildType", "errorLoggingChannelId", "errorLoggingPlatform", "createdAt", "updatedAt")
    SELECT DISTINCT
      "discordGuildId",
      ${discordGuildType},
      "errorLoggingChannelId",
      ${errorLoggingPlatform},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "ChannelMaps"
  `);
  await queryInterface.sequelize.query(`
    INSERT INTO "GuildMaps" ("guildId", "guildType", "errorLoggingChannelId", "errorLoggingPlatform", "createdAt", "updatedAt")
    SELECT DISTINCT
      "fluxerGuildId",
      ${fluxerGuildType},
      "errorLoggingChannelId",
      ${errorLoggingPlatform},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "ChannelMaps"
  `);
  await queryInterface.addColumn("ChannelMaps", "DiscordGuildMapId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "GuildMaps", key: "id" },
  });
  await queryInterface.addColumn("ChannelMaps", "FluxerGuildMapId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "GuildMaps", key: "id" },
  });
  await queryInterface.sequelize.query(`
    UPDATE "ChannelMaps"
    SET "DiscordGuildMapId" = (
      SELECT "id" FROM "GuildMaps"
      WHERE "guildId" = "ChannelMaps"."discordGuildId"
        AND ${discordComparison}
      LIMIT 1
    )
  `);
  await queryInterface.sequelize.query(`
    UPDATE "ChannelMaps"
    SET "FluxerGuildMapId" = (
      SELECT "id" FROM "GuildMaps"
      WHERE "guildId" = "ChannelMaps"."fluxerGuildId"
        AND ${fluxerComparison}
      LIMIT 1
    )
  `);
  await queryInterface.removeColumn("ChannelMaps", "errorLoggingChannelId");
  await queryInterface.removeColumn("ChannelMaps", "errorLoggingPlatform");
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.addColumn("ChannelMaps", "errorLoggingChannelId", {
    type: DataTypes.STRING,
    allowNull: true,
  });
  await queryInterface.addColumn("ChannelMaps", "errorLoggingPlatform", {
    type: DataTypes.ENUM("fluxer", "discord"),
    allowNull: true,
  });
  const isPostgres = queryInterface.sequelize.getDialect() === "postgres";
  const errorLoggingPlatform = isPostgres
    ? `gm."errorLoggingPlatform"::text::"enum_ChannelMaps_errorLoggingPlatform"`
    : `gm."errorLoggingPlatform"`;
  await queryInterface.sequelize.query(`
    UPDATE "ChannelMaps"
    SET
      "errorLoggingChannelId" = gm."errorLoggingChannelId",
      "errorLoggingPlatform"  = ${errorLoggingPlatform}
    FROM "GuildMaps" gm
    WHERE gm."id" = "ChannelMaps"."DiscordGuildMapId"
  `);
  await queryInterface.removeColumn("ChannelMaps", "DiscordGuildMapId");
  await queryInterface.removeColumn("ChannelMaps", "FluxerGuildMapId");
  await queryInterface.dropTable("GuildMaps");
}
