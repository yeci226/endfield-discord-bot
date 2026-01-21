import { Events } from "discord.js";
import { Event } from "../interfaces/Event";
import { Logger } from "../utils/Logger";

const logger = new Logger("系统");

const event: Event = {
  name: Events.Warn,
  execute: async (client, info: string) => {
    logger.warn(`Client Warning: ${info}`);
  },
};

export default event;
