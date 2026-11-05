import { DataTypes, QueryInterface } from "sequelize";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.addColumn("GuildMaps", "guildOptInEnabled", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
  await queryInterface.createTable("GuildUserOptIns", {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    guildType: {
      type: DataTypes.ENUM("discord", "fluxer"),
      allowNull: false,
    },
    guildId: { type: DataTypes.STRING, allowNull: false },
    userId: { type: DataTypes.STRING, allowNull: false },
    optedIn: { type: DataTypes.BOOLEAN, allowNull: false },
    prompted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await queryInterface.addIndex("GuildUserOptIns", ["guildType", "guildId", "userId"], { unique: true });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.dropTable("GuildUserOptIns");
  await queryInterface.removeColumn("GuildMaps", "guildOptInEnabled");
}
