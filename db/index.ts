import {
  Sequelize,
} from "sequelize-typescript";
import Config from "../config";
import { log } from "../utils/Logger";
import { ChannelMap } from "./models/ChannelMap";
import { MessageMap } from "./models/MessageMap";
import { UserConfig } from "./models/UserConfig";

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: Config.DataFolderPath + "/fluxcord.db",
  logging: (msg) => log("DB", msg),
  models: [ChannelMap, MessageMap, UserConfig],
});

export { sequelize, ChannelMap, MessageMap, UserConfig };
