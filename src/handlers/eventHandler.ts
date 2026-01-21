import { Event } from "../interfaces/Event";
import { ExtendedClient } from "../structures/Client";
import fs from "fs";
import path from "path";
import { Logger } from "../utils/Logger";

const logger = new Logger("EventHandler");

export async function loadEvents(client: ExtendedClient) {
  const eventsPath = path.join(__dirname, "../events");
  const eventFiles = fs
    .readdirSync(eventsPath)
    .filter((file) => file.endsWith(".ts") || file.endsWith(".js"));

  for (const file of eventFiles) {
    const event: Event = (await import(`../events/${file}`)).default;
    if (event.once) {
      // @ts-ignore
      client.once(event.name, (...args) => event.execute(client, ...args));
    } else {
      // @ts-ignore
      client.on(event.name, (...args) => event.execute(client, ...args));
    }
    logger.success(`Loaded event: ${event.name}`);
  }
}
