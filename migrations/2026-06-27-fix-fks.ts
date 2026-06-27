import { QueryInterface } from "sequelize";

type SequelizeLike = {
  query: (sql: string, options?: any) => Promise<any>;
  transaction: (cb: (t: any) => Promise<void>) => Promise<void>;
};

async function setForeignKeyCascade(
  qi: SequelizeLike,
  table: string,
  column: string,
  cascadeAction: "CASCADE" | "SET NULL" | "NO ACTION",
  transaction: any,
) {
  const [tableRows] = await qi.query(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=:table;`,
    { replacements: { table }, transaction },
  );
  const createTableSql: string | undefined = (tableRows as any[])?.[0]?.sql;
  if (!createTableSql) {
    throw new Error(`Could not find table "${table}" in sqlite_master`);
  }

  const [indexRows] = await qi.query(
    `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=:table AND sql IS NOT NULL;`,
    { replacements: { table }, transaction },
  );
  const indexSqls: string[] = (indexRows as any[]).map((r: any) => r.sql);

  const fkRegex = new RegExp(
    "`?" +
      column +
      "`?\\s+INTEGER\\s+REFERENCES\\s+`?([A-Za-z0-9_]+)`?\\s*\\(\\s*`?([A-Za-z0-9_]+)`?\\s*\\)" +
      "(\\s+ON DELETE [A-Z ]+?)?(\\s+ON UPDATE [A-Z ]+?)?(?=[,)])",
    "i",
  );

  const match = createTableSql.match(fkRegex);
  if (!match) {
    throw new Error(
      `Could not locate FK clause for ${table}.${column} in: ${createTableSql}`,
    );
  }

  const refTable = match[1];
  const refColumn = match[2];

  const newClause =
    `\`${column}\` INTEGER REFERENCES \`${refTable}\` (\`${refColumn}\`)` +
    ` ON DELETE ${cascadeAction} ON UPDATE CASCADE`;

  const newCreateSql = createTableSql.replace(fkRegex, newClause);

  const tempName = `${table}_fk_rebuild_tmp`;
  const tempCreateSql = newCreateSql.replace(
    new RegExp("`?" + table + "`?(?=\\s*\\()"),
    `\`${tempName}\``,
  );

  await qi.query(tempCreateSql, { transaction });
  await qi.query(`INSERT INTO \`${tempName}\` SELECT * FROM \`${table}\`;`, {
    transaction,
  });
  await qi.query(`DROP TABLE \`${table}\`;`, { transaction });
  await qi.query(`ALTER TABLE \`${tempName}\` RENAME TO \`${table}\`;`, {
    transaction,
  });

  for (const sql of indexSqls) {
    await qi.query(sql, { transaction });
  }
}

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  const qi = queryInterface.sequelize as unknown as SequelizeLike;

  await qi.query("PRAGMA foreign_keys=OFF;");

  await qi.transaction(async (transaction) => {
    await setForeignKeyCascade(
      qi,
      "MessageMaps",
      "ChannelMapId",
      "CASCADE",
      transaction,
    );
    await setForeignKeyCascade(
      qi,
      "ChannelMaps",
      "DiscordGuildMapId",
      "CASCADE",
      transaction,
    );
    await setForeignKeyCascade(
      qi,
      "ChannelMaps",
      "FluxerGuildMapId",
      "CASCADE",
      transaction,
    );
  });

  await qi.query("PRAGMA foreign_keys=ON;");
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  const qi = queryInterface.sequelize as unknown as SequelizeLike;

  await qi.query("PRAGMA foreign_keys=OFF;");

  await qi.transaction(async (transaction) => {
    await setForeignKeyCascade(
      qi,
      "MessageMaps",
      "ChannelMapId",
      "SET NULL",
      transaction,
    );
    await setForeignKeyCascade(
      qi,
      "ChannelMaps",
      "DiscordGuildMapId",
      "NO ACTION",
      transaction,
    );
    await setForeignKeyCascade(
      qi,
      "ChannelMaps",
      "FluxerGuildMapId",
      "NO ACTION",
      transaction,
    );
  });

  await qi.query("PRAGMA foreign_keys=ON;");
}
