import { Client, Collection, GatewayIntentBits, Partials } from "discord.js";
import {
  ClusterClient,
  getInfo,
  AutoResharderClusterClient,
} from "discord-hybrid-sharding";
import { CustomDatabase } from "../utils/Database";
import { Command } from "../interfaces/Command";
import path from "path";
import dotenv from "dotenv";
import { SkportNewsService } from "../services/SkportNewsService";
import { AutoDailyService } from "../services/AutoDailyService";

dotenv.config();

export class ExtendedClient extends Client {
  public commands: Collection<string, Command> = new Collection();
  public db: CustomDatabase;
  public newsService!: SkportNewsService;
  public autoDailyService!: AutoDailyService;
  public cluster: ClusterClient<Client>;

  constructor() {
    const isSharded = process.env.CLUSTER !== undefined;

    super({
      intents: [GatewayIntentBits.Guilds],
      partials: [
        Partials.Channel,
        Partials.GuildMember,
        Partials.Message,
        Partials.User,
      ],
      shards: isSharded ? getInfo().SHARD_LIST : [0],
      shardCount: isSharded ? getInfo().TOTAL_SHARDS : 1,
    });

    if (isSharded) {
      this.cluster = new ClusterClient(this);
      new AutoResharderClusterClient(this.cluster);
    } else {
      // Standalone mode: Provide a mock for sharding properties
      this.cluster = {
        id: 0,
        broadcastEval: async () => [],
      } as any;
    }
    this.db = new CustomDatabase("json.sqlite");
  }

  public start() {
    const isDev = process.env.NODE_ENV === "development";
    const token = isDev
      ? process.env.TEST_DISCORD_TOKEN
      : process.env.DISCORD_TOKEN;

    if (!token) {
      console.error(
        `❌ ${
          isDev ? "TEST_DISCORD_TOKEN" : "DISCORD_TOKEN"
        } is not set in .env`,
      );
      process.exit(1);
    }
    this.login(token);
    console.log(
      `[Cluster ${this.cluster.id}] Client logged in. Shards: ${getInfo().SHARD_LIST.join(", ")}`,
    );
  }
}
