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
    shardsPerClusters: 2,
    totalShards: "auto",
    mode: "process", // or 'worker'
    token: token,
    execArgv: isDev ? ["-r", "ts-node/register"] : [],
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

manager.on("clusterCreate", (cluster) =>
  logger.info(`Launched Cluster ${cluster.id}`),
);

manager.spawn({ timeout: -1 });
