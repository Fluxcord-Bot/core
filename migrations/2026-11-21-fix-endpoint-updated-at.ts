import { QueryInterface } from "sequelize";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  if (queryInterface.sequelize.getDialect() !== "sqlite") return;
  await queryInterface.sequelize.query(
    `UPDATE "BridgeEndpoints"
     SET "updatedAt" = strftime('%Y-%m-%d %H:%M:%f', "updatedAt" / 1000.0, 'unixepoch') || ' +00:00'
     WHERE typeof("updatedAt") IN ('integer', 'real')`
  );
}

export async function down() {}
