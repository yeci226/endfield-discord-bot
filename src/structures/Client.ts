import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Options,
  Partials,
} from "discord.js";

// Only guilds/channels/roles caches are read by this bot. Everything else is
// dropped; the bot's own member/user stays so permission checks still work.
const isSelf = (x: { id: string; client: Client }) => x.id === x.client.user?.id;
const makeCache = Options.cacheWithLimits({
  ...Options.DefaultMakeCacheSettings,
  MessageManager: 0,
  ReactionManager: 0,
  GuildEmojiManager: 0,
  GuildStickerManager: 0,
  PresenceManager: 0,
  VoiceStateManager: 0,
  ThreadMemberManager: 0,
  UserManager: { maxSize: 0, keepOverLimit: isSelf },
  GuildMemberManager: { maxSize: 0, keepOverLimit: isSelf },
});
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
import { MonitorService } from "../services/MonitorService";
import { CharacterWikiService } from "../services/CharacterWikiService";
import { Logger } from "../utils/Logger";
import { StartupHooks } from "../utils/startup";

dotenv.config();

export class ExtendedClient extends Client {
  public commands: Collection<string, Command> = new Collection();
  public db: CustomDatabase;
  public newsService!: SkportNewsService;
  public autoDailyService!: AutoDailyService;
  public monitorService!: MonitorService;
  public wikiService!: CharacterWikiService;
  public cluster: ClusterClient<Client>;
  private logger!: Logger;
  public startup: StartupHooks;
  private memoryInterval: NodeJS.Timeout | null = null;

  constructor() {
    const isSharded = process.env.CLUSTER !== undefined;

    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [
        Partials.Channel,
        Partials.GuildMember,
        Partials.Message,
        Partials.User,
      ],
      makeCache,
      shards: isSharded ? getInfo().SHARD_LIST : [0],
      shardCount: isSharded ? getInfo().TOTAL_SHARDS : 1,
    });

    if (isSharded) {
      this.cluster = new ClusterClient(this);
      // Enable the manager's heartbeat and restart-budget reset after login.
      this.once(Events.ClientReady, () => this.cluster.triggerReady());
      new AutoResharderClusterClient(this.cluster);
    } else {
      // Standalone mode: Provide a mock for sharding properties
      this.cluster = {
        id: 0,
        broadcastEval: async () => [],
      } as any;
    }
    this.db = new CustomDatabase("json.sqlite");
    this.logger = new Logger(`Cluster ${this.cluster.id}`);
    this.startup = new StartupHooks({
      info: (msg) => this.logger.info(msg),
      error: (msg, err) =>
        err === undefined ? this.logger.error(msg) : this.logger.error(msg, err),
    });
  }

  /** Resolves once the gateway login succeeded; exits the process (code 1) if it fails. */
  public async start(): Promise<void> {
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
    try {
      await this.login(token);
    } catch (error: any) {
      this.logger.error(`Login failed: ${error?.message || error}`);
      process.exit(1);
      return;
    }
    const shards = this.options.shards;
    this.logger.success(
      `Client logged in. Shards: ${Array.isArray(shards) ? shards.join(", ") : shards}`,
    );

    // Memory monitoring
    this.memoryInterval = setInterval(
      () => {
        const used = process.memoryUsage();
        const heapUsedMB = (used.heapUsed / 1024 / 1024).toFixed(2);
        const heapTotalMB = (used.heapTotal / 1024 / 1024).toFixed(2);
        const rssMB = (used.rss / 1024 / 1024).toFixed(2);
        this.logger.info(
          `Memory Status: Heap Used: ${heapUsedMB} MB / Total: ${heapTotalMB} MB | RSS: ${rssMB} MB`,
        );
      },
      15 * 60 * 1000,
    ); // Every 15 minutes
  }

  public stop() {
    if (this.memoryInterval) {
      clearInterval(this.memoryInterval);
      this.memoryInterval = null;
    }
  }
}
