import fs from "node:fs";
import { Sequelize } from "sequelize";
import { Umzug, SequelizeStorage } from "umzug";
import Config from "./utils/ConfigHandler.js";
import sqlite3 from "@journeyapps/sqlcipher";

const TABLES = [
  "GuildMaps",
  "ChannelMaps",
  "MessageMaps",
  "UserConfigs",
  "VoiceChannelMaps",
];

const force = process.argv.includes("--force");

if (!Config.PostgresConnectionString) {
  console.error("PostgresConnectionString is not set. Set it in config.js before running this script.");
  process.exit(1);
}

const dbPath = Config.DataFolderPath + "/fluxcord.db";

if (!fs.existsSync(dbPath)) {
  console.error(`SQLite database not found at ${dbPath}. Nothing to migrate.`);
  process.exit(1);
}

async function openSource() {
  if (Config.DatabaseEncryptionToken) {
    const keyed = new Sequelize({
      dialect: "sqlite",
      dialectModule: sqlite3,
      storage: dbPath,
      logging: false,
      password: Config.DatabaseEncryptionToken,
    });
    try {
      await keyed.query("PRAGMA cipher_compatibility = 4;");
      await keyed.query(`PRAGMA key = ${keyed.escape(Config.DatabaseEncryptionToken)};`);
      await keyed.query("SELECT count(*) FROM sqlite_master;");
      return { sequelize: keyed, encrypted: true };
    } catch {
      await keyed.close();
    }
    const plain = new Sequelize({
      dialect: "sqlite",
      dialectModule: sqlite3,
      storage: dbPath,
      logging: false,
    });
    try {
      await plain.query("SELECT count(*) FROM sqlite_master;");
      console.warn("DatabaseEncryptionToken is set but the SQLite database is not encrypted. Migrating plaintext database.");
      return { sequelize: plain, encrypted: false };
    } catch (err) {
      await plain.close();
      throw new Error(
        "Could not open SQLite database with or without the encryption token. Check DatabaseEncryptionToken.",
      );
    }
  }
  const plain = new Sequelize({
    dialect: "sqlite",
    dialectModule: sqlite3,
    storage: dbPath,
    logging: false,
  });
  try {
    await plain.query("SELECT count(*) FROM sqlite_master;");
  } catch {
    await plain.close();
    console.error("Could not open SQLite database. If it is encrypted, set DatabaseEncryptionToken in config.js first.");
    process.exit(1);
  }
  return { sequelize: plain, encrypted: false };
}

const { sequelize: source, encrypted } = await openSource();

console.log(`Opened SQLite source (encrypted: ${encrypted ? "yes" : "no"}).`);

const target = new Sequelize(Config.PostgresConnectionString, {
  dialect: "postgres",
  logging: false,
});

try {
  await target.query("SELECT 1;");
} catch (err) {
  console.error("Could not connect to Postgres. Check PostgresConnectionString.", err);
  await source.close();
  await target.close();
  process.exit(1);
}

const umzug = new Umzug({
  migrations: { glob: "migrations/*.ts" },
  context: target.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize: target }),
  logger: console,
});

await umzug.up();
console.log("Postgres schema is up to date.");

const targetQi = target.getQueryInterface();

async function countRows(seq, table) {
  const [[row]] = await seq.query(`SELECT COUNT(*)::int AS "count" FROM "${table}";`);
  return row.count;
}

if (!force) {
  for (const table of TABLES) {
    const n = await countRows(target, table);
    if (n > 0) {
      console.error(
        `Postgres table "${table}" already has ${n} rows. Re-run with --force to delete Postgres data and copy again.`,
      );
      await source.close();
      await target.close();
      process.exit(1);
    }
  }
} else {
  await target.query('TRUNCATE "MessageMaps", "ChannelMaps", "GuildMaps", "UserConfigs", "VoiceChannelMaps" RESTART IDENTITY CASCADE;');
}

for (const table of TABLES) {
  const rows = await source.query(`SELECT * FROM "${table}" ORDER BY "id";`, {
    type: "SELECT",
  });
  if (rows.length === 0) {
    console.log(`${table}: 0 rows, skipping.`);
    continue;
  }
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await targetQi.bulkInsert(table, rows.slice(i, i + chunkSize), {});
  }
  console.log(`${table}: copied ${rows.length} rows.`);
}

for (const table of TABLES) {
  await target.query(
    `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX("id") FROM "${table}"), 1));`,
  );
}

let mismatch = false;
for (const table of TABLES) {
  const [[s]] = await source.query(`SELECT COUNT(*) AS "count" FROM "${table}";`);
  const t = await countRows(target, table);
  const sn = Number(s.count);
  console.log(`${table}: sqlite=${sn} postgres=${t}`);
  if (sn !== t) mismatch = true;
}

await source.close();
await target.close();

if (mismatch) {
  console.error("Row counts do not match. Migration may be incomplete.");
  process.exit(1);
}

console.log("Done! Set PostgresConnectionString in config.js and start the bot to use Postgres.");
