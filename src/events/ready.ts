import { Events, REST, Routes, ActivityType } from "discord.js";
import { Event } from "../interfaces/Event";
import { Logger } from "../utils/Logger";

const logger = new Logger("Ready");

async function updatePresence(client: any) {
  const results = await client.cluster.broadcastEval(
    (c: any) => c.guilds.cache.size,
  );
  const totalGuilds = results.reduce(
    (prev: number, val: number) => prev + val,
    0,
  );

  client.user?.setPresence({
    activities: [
      {
        name: `${totalGuilds} 個伺服器`,
        type: ActivityType.Watching,
      },
    ],
    status: "online",
  });
}

const event: Event = {
  name: Events.ClientReady,
  once: true,
  execute: async (client) => {
    logger.success(`Ready! Logged in as ${client.user?.tag}`);

    // Register commands here if client ID is available or use a fixed client ID from env
    // Best practice with discord.js v14 is usually separate deploy script or on ready.
    // We will do it here for simplicity as we have client.commands loaded.

    const commandsData = client.commands.map((c) => c.data.toJSON());
    const isDev = process.env.NODE_ENV === "development";
    const token = isDev
      ? process.env.TEST_DISCORD_TOKEN
      : process.env.DISCORD_TOKEN;
    const rest = new REST({ version: "10" }).setToken(token!);

    try {
      logger.info("Started refreshing application (/) commands.");
      await rest.put(Routes.applicationCommands(client.user!.id), {
        body: commandsData,
      });
      logger.success("Successfully reloaded application (/) commands.");
    } catch (error: any) {
      logger.error(error.message || String(error));
    }

    setInterval(() => updatePresence(client), 10000);
  },
};

export default event;
