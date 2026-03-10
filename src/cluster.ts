import {
  ClusterManager,
  ReClusterManager,
  HeartbeatManager,
  AutoResharderManager,
} from "discord-hybrid-sharding";
import dotenv from "dotenv";
import { join } from "path";
import { Logger } from "./utils/Logger";

dotenv.config();

const isDev = process.env.NODE_ENV === "development";
const token = isDev
  ? process.env.TEST_DISCORD_TOKEN
  : process.env.DISCORD_TOKEN;

if (!token) {
  console.error(
    `❌ ${isDev ? "TEST_DISCORD_TOKEN" : "DISCORD_TOKEN"} is not set in .env`,
  );
  process.exit(1);
}

const manager = new ClusterManager(
  join(__dirname, isDev ? "index.ts" : "index.js"),
  {
    totalClusters: "auto",
    totalShards: "auto",
    mode: "process", // or 'worker'
    token: token,
    execArgv: isDev
      ? ["-r", "ts-node/register", "--max-old-space-size=2048"]
      : ["--max-old-space-size=2048"],
  },
);

manager.extend(
  new ReClusterManager({
    restartMode: "gracefulSwitch",
  }),
  new HeartbeatManager({
    interval: 2000,
    maxMissedHeartbeats: 5,
  }),
  new AutoResharderManager({
    ShardsPerCluster: 2,
    MaxGuildsPerShard: 2000,
  }),
);

const logger = new Logger("Cluster Manager");

manager.on("clusterCreate", (cluster) => {
  cluster.on("ready", () => {
    logger.info(`Launched Cluster ${cluster.id}`);
    setInterval(
      () => {
        const memory = process.memoryUsage();
        logger.info(
          `[Cluster #${cluster.id}] RSS: ${(memory.rss / 1024 / 1024).toFixed(2)}MB, Heap: ${(memory.heapUsed / 1024 / 1024).toFixed(2)}MB`,
        );
      },
      1000 * 60 * 10,
    );
  });

  cluster.on("reconnecting", () => {
    logger.info(`Reconnecting Cluster #${cluster.id}`);
  });

  cluster.on("death", () => {
    logger.info(`Restarting Cluster ${cluster.id}`);
    manager.recluster?.start();
  });
});

process.on("uncaughtException", (error) => {
  try {
    logger.error(`Uncaught Exception: ${error}`);
  } catch {}
});

process.on("unhandledRejection", (reason) => {
  try {
    logger.error(`Unhandled Rejection: ${reason}`);
  } catch {}
});

(async () => {
  try {
    await manager.spawn({ timeout: -1 });
  } catch (error) {
    logger.error(`Failed to spawn clusters: ${error}`);
    process.exit(1);
  }
})();
