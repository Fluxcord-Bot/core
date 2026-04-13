import { QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.sequelize.query(`
    DELETE FROM "MessageMaps"
    WHERE "ChannelMapId" IS NOT NULL
      AND "ChannelMapId" NOT IN (SELECT "id" FROM "ChannelMaps")
  `);

  await queryInterface.sequelize.query(`
    DELETE FROM "ChannelMaps"
    WHERE "DiscordGuildMapId" IS NOT NULL
      AND "DiscordGuildMapId" NOT IN (SELECT "id" FROM "GuildMaps")
  `);

  await queryInterface.sequelize.query(`
    DELETE FROM "ChannelMaps"
    WHERE "FluxerGuildMapId" IS NOT NULL
      AND "FluxerGuildMapId" NOT IN (SELECT "id" FROM "GuildMaps")
  `);

  await queryInterface.sequelize.query(`
    DELETE FROM "MessageMaps"
    WHERE "ChannelMapId" IS NOT NULL
      AND "ChannelMapId" NOT IN (SELECT "id" FROM "ChannelMaps")
  `);
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
}