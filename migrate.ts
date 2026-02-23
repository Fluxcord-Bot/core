import { Umzug, SequelizeStorage } from "umzug";
import { sequelize } from "./db";

const umzug = new Umzug({
  migrations: { glob: "migrations/*.ts" },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: console,
});

await umzug.up();
