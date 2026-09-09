import { QueryInterface } from "sequelize";
import Config from "../utils/ConfigHandler.js";
import sqlite3 from "@journeyapps/sqlcipher";

const TARGETS = [
  { table: "ChannelMaps", column: "DiscordGuildMapId", refTable: "GuildMaps" },
  { table: "ChannelMaps", column: "FluxerGuildMapId", refTable: "GuildMaps" },
  { table: "MessageMaps", column: "ChannelMapId", refTable: "ChannelMaps" },
];

const CASCADE_SUFFIX = " ON DELETE CASCADE ON UPDATE CASCADE";

/** @param {any} db @param {string} sql */
export function run(db, sql) {
  return new Promise((resolve, reject) =>
    db.run(sql, (err) => (err ? reject(err) : resolve())),
  );
}

/**
 * @param {any} db
 * @param {string} sql
 * @returns {Promise<any[]>}
 */
export function get(db, sql) {
  return new Promise((resolve, reject) =>
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))),
  );
}

/** @param {boolean} enableCascade */
async function fixPostgres(queryInterface, enableCascade) {
  const s = queryInterface.sequelize;
  const qi = queryInterface;
  for (const { table, column, refTable } of TARGETS) {
    const [rows] = await s.query(
      `SELECT con.conname, con.confdeltype
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_class ref ON ref.oid = con.confrelid
       WHERE rel.relname = ${s.escape(table)}
         AND ref.relname = ${s.escape(refTable)}
         AND con.contype = 'f'
         AND con.conkey[1] = (
           SELECT a.attnum FROM pg_attribute a
           WHERE a.attrelid = rel.oid AND a.attname = ${s.escape(column)}
         )`,
    );
    const constraints = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const cascade = constraints.filter((c) => c.confdeltype === "c");
    const others = constraints.filter((c) => c.confdeltype !== "c");
    const needsFix = enableCascade
      ? cascade.length !== 1 || others.length > 0
      : cascade.length > 0;
    if (!needsFix) continue;
    for (const c of constraints) {
      if (enableCascade && c.confdeltype === "c" && cascade.length === 1) continue;
      await s.query(
        `ALTER TABLE ${qi.quoteIdentifier(table)} DROP CONSTRAINT ${qi.quoteIdentifier(c.conname)};`,
      );
    }
    const [rows2] = await s.query(
      `SELECT count(*)::int AS n FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname = ${s.escape(table)} AND con.contype = 'f'
         AND con.conkey[1] = (
           SELECT a.attnum FROM pg_attribute a
           WHERE a.attrelid = rel.oid AND a.attname = ${s.escape(column)}
         )`,
    );
    const stillThere = rows2?.[0]?.n;
    if (enableCascade && !stillThere) {
      await s.query(
        `ALTER TABLE ${qi.quoteIdentifier(table)}
         ADD CONSTRAINT ${qi.quoteIdentifier(`${table}_${column}_fkey`)}
         FOREIGN KEY (${qi.quoteIdentifier(column)})
         REFERENCES ${qi.quoteIdentifier(refTable)} (${qi.quoteIdentifier("id")}) ON DELETE CASCADE ON UPDATE CASCADE;`,
      );
    }
    if (!enableCascade && !stillThere) {
      await s.query(
        `ALTER TABLE ${qi.quoteIdentifier(table)}
         ADD CONSTRAINT ${qi.quoteIdentifier(`${table}_${column}_fkey`)}
         FOREIGN KEY (${qi.quoteIdentifier(column)})
         REFERENCES ${qi.quoteIdentifier(refTable)} (${qi.quoteIdentifier("id")});`,
      );
    }
  }
}

/** @returns {Promise<import("@journeyapps/sqlcipher").Database>} */
async function openSourceDb() {
  const dbPath = Config.DataFolderPath + "/fluxcord.db";
  /** @type {import("@journeyapps/sqlcipher").Database | null} */
  let keyed = null;
  if (Config.DatabaseEncryptionToken) {
    try {
      keyed = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) =>
          err ? reject(err) : resolve(db),
        );
      });
      await run(keyed, "PRAGMA cipher_compatibility = 4;");
      await run(
        keyed,
        `PRAGMA key = '${Config.DatabaseEncryptionToken.replace(/'/g, "''")}'`,
      );
      await get(keyed, "SELECT count(*) FROM sqlite_master;");
      return keyed;
    } catch {
      try {
        if (keyed) await new Promise((res) => keyed.close(res));
      } catch {}
      keyed = null;
    }
  }
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) =>
      err ? reject(err) : resolve(db),
    );
  });
}

/**
 * @param {import("@journeyapps/sqlcipher").Database} db
 * @param {string} table
 * @param {string} refTable
 * @param {boolean} enableCascade
 * @returns {Promise<boolean>}
 */
export async function rebuildTable(db, table, refTable, enableCascade) {
  const rows = await get(db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${table}';`);
  const ddl = rows[0]?.sql;
  if (!ddl) return false;
  const bare = `REFERENCES \`${refTable}\` (\`id\`)`;
  const full = bare + CASCADE_SUFFIX;
  const patched = enableCascade
    ? ddl.replace(new RegExp(`${bare.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}(?! ON DELETE)`, "g"), full)
    : ddl.replace(new RegExp(`${full.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}`, "g"), bare);
  if (patched === ddl) return false;

  const tempName = `${table}__rebuild`;
  const newDdl = patched.replace(
    `CREATE TABLE \`${table}\``,
    `CREATE TABLE \`${tempName}\``,
  );

  await run(db, "PRAGMA foreign_keys = OFF;");
  await run(db, "BEGIN;");
  try {
    await run(db, newDdl + ";");
    await run(db, `INSERT INTO \`${tempName}\` SELECT * FROM \`${table}\`;`);
    const oldCount = (await get(db, `SELECT COUNT(*) AS n FROM \`${table}\`;`))[0]?.n;
    const newCount = (await get(db, `SELECT COUNT(*) AS n FROM \`${tempName}\`;`))[0]?.n;
    if (oldCount !== newCount) {
      throw new Error(`Row count mismatch while rebuilding ${table} (${oldCount} -> ${newCount})`);
    }
    const indexes = await get(db, `PRAGMA index_list(\`${table}\`);`);
    const indexSqls = [];
    for (const idx of indexes) {
      if (idx.origin !== "c") continue;
      const [ix] = await get(db, `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '${idx.name}' AND tbl_name = '${table}';`);
      if (ix?.sql) indexSqls.push(ix.sql);
    }
    await run(db, `DROP TABLE \`${table}\`;`);
    await run(db, `ALTER TABLE \`${tempName}\` RENAME TO \`${table}\`;`);
    for (const sql of indexSqls) {
      await run(db, sql + ";");
    }
    await run(db, "COMMIT;");
  } catch (e) {
    try {
      await run(db, "ROLLBACK;");
    } catch {}
    throw e;
  } finally {
    await run(db, "PRAGMA foreign_keys = ON;");
  }
  return true;
}

/** @param {boolean} enableCascade */
async function fixSqlite(enableCascade) {
  const db = await openSourceDb();
  try {
    const tables = [...new Set(TARGETS.map((t) => t.table))];
    for (const table of tables) {
      const refTable = TARGETS.find((t) => t.table === table)?.refTable ?? "";
      await rebuildTable(db, table, refTable, enableCascade);
    }
  } finally {
    await new Promise((res) => db.close(res));
  }
}

export async function up({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  if (queryInterface.sequelize.getDialect() === "postgres") {
    await fixPostgres(queryInterface, true);
    return;
  }
  await fixSqlite(true);
}

export async function down({
  context: queryInterface,
}: {
  context: QueryInterface;
}) {
  if (queryInterface.sequelize.getDialect() === "postgres") {
    await fixPostgres(queryInterface, false);
    return;
  }
  await fixSqlite(false);
}
