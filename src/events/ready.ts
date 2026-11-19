import { Events, REST, Routes, ActivityType } from "discord.js";
import { Event } from "../interfaces/Event";
import { Logger } from "../utils/Logger";
import { registerCommandsIfChanged } from "../utils/commandRegistry";
import { createPresenceUpdater } from "../utils/presence";

const logger = new Logger("Ready");

const PRESENCE_TOTAL_KEY = "presence.guildTotal";
const presenceText = (total: number) => `${total} 個伺服器`;

function setLocalPresence(client: any, total: number) {
  client.user?.setPresence({
    activities: [{ name: presenceText(total), type: ActivityType.Watching }],
    status: "online",
  });
}

/** Cluster 0 only: one broadcastEval to count, one to push the same presence everywhere. */
function createClusterPresenceTick(client: any) {
  return createPresenceUpdater({
    getTotal: async () => {
      const results: number[] = await client.cluster.broadcastEval(
        (c: any) => c.guilds.cache.size,
      );
      if (!results.length) return client.guilds.cache.size; // standalone mode
      return results.reduce((prev, val) => prev + Number(val || 0), 0);
    },
    push: async (total) => {
      setLocalPresence(client, total);
      await client.db.set(PRESENCE_TOTAL_KEY, total);
      await client.cluster.broadcastEval(
        // 3 = ActivityType.Watching (imports are not available inside broadcastEval)
        (c: any, ctx: { name: string }) => {
          c.user?.setPresence({
            activities: [{ name: ctx.name, type: 3 }],
            status: "online",
          });
          return true;
        },
        { context: { name: presenceText(total) } },
      );
    },
  });
}

const event: Event = {
  name: Events.ClientReady,
  once: true,
  execute: async (client) => {
    logger.success(`Ready! Logged in as ${client.user?.tag}`);

    // Only cluster 0 registers the global commands, and only when their
    // definitions changed since the last successful registration.
    if (client.cluster.id === 0) {
      const isDev = process.env.NODE_ENV === "development";
      const token = isDev
        ? process.env.TEST_DISCORD_TOKEN
        : process.env.DISCORD_TOKEN;
      const rest = new REST({ version: "10" }).setToken(token!);
      await registerCommandsIfChanged({
        db: client.db,
        commandsJson: client.commands.map((c) => c.data.toJSON()),
        put: (body) =>
          rest.put(Routes.applicationCommands(client.user!.id), { body }),
        log: logger,
      }).catch((error: any) =>
        logger.error(`Command registration check failed: ${error?.message || error}`),
      );
    }

    // A freshly (re)spawned cluster shows the last known total straight away.
    try {
      const saved = await client.db.get<number>(PRESENCE_TOTAL_KEY);
      if (typeof saved === "number" && saved > 0) setLocalPresence(client, saved);
    } catch {}

    const presenceTick = createClusterPresenceTick(client);
    client.startup.every("presence", 60_000, async () => {
      await presenceTick();
    });
    await client.startup.run(client.cluster.id === 0);
    // Not awaited and not a startup hook: broadcastEval may wait for clusters
    // that are still booting and must not delay the other startup hooks.
    if (client.cluster.id === 0) void presenceTick();
  },
};

export default event;
