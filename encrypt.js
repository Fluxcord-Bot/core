import fs from "node:fs";
import { Sequelize } from "sequelize-typescript";
import Config from "./utils/ConfigHandler.js";
import sqlite3 from "@journeyapps/sqlcipher";

if (!Config.DatabaseEncryptionToken) {
  console.log(
    "DatabaseEncryptionToken is not set. Set it in config.js before running this script.",
  );
  process.exit(1);
}

const dbPath = Config.DataFolderPath + "/fluxcord.db";
const tmpPath = dbPath + ".tmp";
const backupPath = dbPath + ".bak";

try {
  const check = new Sequelize({
    dialect: "sqlite",
    dialectModule: sqlite3,
    storage: dbPath,
    logging: false,
  });

  try {
    await check.query(
      `PRAGMA key = ${check.escape(Config.DatabaseEncryptionToken)};`,
    );
    await check.query("PRAGMA cipher_compatibility = 4;");
    await check.query("SELECT count(*) FROM sqlite_master;");
    await check.close();

    console.log("Database is already encrypted.");
    process.exit(0);
  } catch {
    await check.close();
  }

  const sequelize = new Sequelize({
    dialect: "sqlite",
    dialectModule: sqlite3,
    storage: dbPath,
    logging: false,
  });

  await sequelize.query("SELECT count(*) FROM sqlite_master;");

  console.log("Encrypting database...");

  await sequelize.query(`
    ATTACH DATABASE ${sequelize.escape(tmpPath)}
    AS encrypted
    KEY ${sequelize.escape(Config.DatabaseEncryptionToken)};
  `);

  await sequelize.query("PRAGMA encrypted.cipher_compatibility = 4;");
  await sequelize.query("SELECT sqlcipher_export('encrypted');");
  await sequelize.query("DETACH DATABASE encrypted;");

  await sequelize.close();

  console.log("Verifying encrypted database...");

  const verify = new Sequelize({
    dialect: "sqlite",
    dialectModule: sqlite3,
    storage: tmpPath,
    logging: false,
  });

  await verify.query(
    `PRAGMA key = ${verify.escape(Config.DatabaseEncryptionToken)};`,
  );
  await verify.query("PRAGMA cipher_compatibility = 4;");
  await verify.query("SELECT count(*) FROM sqlite_master;");
  await verify.close();

  console.log("Replacing database...");

  fs.renameSync(dbPath, backupPath);
  fs.renameSync(tmpPath, dbPath);

  console.log("Done!");
  console.log(`Backup saved as: ${backupPath}`);
  console.log(
    "Once you've confirmed the bot works, you can delete the backup.",
  );
} catch (err) {
  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  console.error("Encryption failed:", err);
  process.exit(1);
}
