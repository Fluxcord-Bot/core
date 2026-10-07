import { DataTypes, QueryInterface } from "sequelize";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.addColumn("GuildMaps", "customBio", {
    type: DataTypes.STRING,
    allowNull: true,
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.removeColumn("GuildMaps", "customBio");
}
