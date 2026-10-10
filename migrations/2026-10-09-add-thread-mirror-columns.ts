import { DataTypes, QueryInterface } from "sequelize";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.addColumn("ChannelMaps", "autoMirrored", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
  await queryInterface.addColumn("ChannelMaps", "parentChannelMapId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  });
  await queryInterface.addColumn("ChannelMaps", "tagMap", {
    type: DataTypes.JSON,
    allowNull: true,
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.removeColumn("ChannelMaps", "tagMap");
  await queryInterface.removeColumn("ChannelMaps", "parentChannelMapId");
  await queryInterface.removeColumn("ChannelMaps", "autoMirrored");
}
