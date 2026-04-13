import { QueryInterface } from "sequelize";

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.removeConstraint("MessageMaps", "MessageMaps_ChannelMapId_fkey");
  await queryInterface.addConstraint("MessageMaps", {
    fields: ["ChannelMapId"],
    type: "foreign key",
    name: "MessageMaps_ChannelMapId_fkey",
    references: { table: "ChannelMaps", field: "id" },
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  });

  await queryInterface.removeConstraint("ChannelMaps", "ChannelMaps_DiscordGuildMapId_fkey");
  await queryInterface.addConstraint("ChannelMaps", {
    fields: ["DiscordGuildMapId"],
    type: "foreign key",
    name: "ChannelMaps_DiscordGuildMapId_fkey",
    references: { table: "GuildMaps", field: "id" },
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  });

  await queryInterface.removeConstraint("ChannelMaps", "ChannelMaps_FluxerGuildMapId_fkey");
  await queryInterface.addConstraint("ChannelMaps", {
    fields: ["FluxerGuildMapId"],
    type: "foreign key",
    name: "ChannelMaps_FluxerGuildMapId_fkey",
    references: { table: "GuildMaps", field: "id" },
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  });
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  await queryInterface.removeConstraint("MessageMaps", "MessageMaps_ChannelMapId_fkey");
  await queryInterface.addConstraint("MessageMaps", {
    fields: ["ChannelMapId"],
    type: "foreign key",
    name: "MessageMaps_ChannelMapId_fkey",
    references: { table: "ChannelMaps", field: "id" },
    onDelete: "SET NULL",
    onUpdate: "CASCADE",
  });

  await queryInterface.removeConstraint("ChannelMaps", "ChannelMaps_DiscordGuildMapId_fkey");
  await queryInterface.addConstraint("ChannelMaps", {
    fields: ["DiscordGuildMapId"],
    type: "foreign key",
    name: "ChannelMaps_DiscordGuildMapId_fkey",
    references: { table: "GuildMaps", field: "id" },
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  });

  await queryInterface.removeConstraint("ChannelMaps", "ChannelMaps_FluxerGuildMapId_fkey");
  await queryInterface.addConstraint("ChannelMaps", {
    fields: ["FluxerGuildMapId"],
    type: "foreign key",
    name: "ChannelMaps_FluxerGuildMapId_fkey",
    references: { table: "GuildMaps", field: "id" },
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  });
}