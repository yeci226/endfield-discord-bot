import { startTelemetry } from "./telemetry.js";
import { ExtendedClient } from "./structures/Client";
import { loadCommands } from "./handlers/commandHandler";
import { loadEvents } from "./handlers/eventHandler";
import { SkportNewsService } from "./services/SkportNewsService";
import { AutoDailyService } from "./services/AutoDailyService";
import { MonitorService } from "./services/MonitorService";
import { VerificationClient } from "./web/VerificationClient";
import { CharacterWikiService } from "./services/CharacterWikiService";
import { WebManager } from "./web/WebManager";
import dotenv from "dotenv";
import { WebhookClient } from "discord.js";
import { Logger } from "./utils/Logger";
import { installProcessErrorHandlers } from "./utils/processErrors";
import { startGachaStorageJobs } from "./features/gacha/gachaLeaderboard";

dotenv.config();

(async () => {
  // First thing, on every cluster: a crash while loading must still be reported.
  installProcessErrorHandlers({
    logger: new Logger("Process"),
    webhook: process.env.ERRWEBHOOK
      ? new WebhookClient({ url: process.env.ERRWEBHOOK })
      : null,
  });

  const client = new ExtendedClient();
  startTelemetry(client, client.cluster, 'endfield', 'Endfield', process.env.JLWEBHOOK);
  client.newsService = new SkportNewsService(client);
  client.autoDailyService = new AutoDailyService(client);
  client.monitorService = new MonitorService(client);
  client.wikiService = new CharacterWikiService(client);

  await loadCommands(client);
  await loadEvents(client);
  await client.start();

  // Initialize WebManager and VerificationClient (will start later based on cluster)
  const webManager = new WebManager(client);
  const verifyClient = new VerificationClient(client);

  // 只有在 Cluster 0 啟動全域服務
  if (client.cluster.id === 0) {
    // 啟動服務
    webManager.start();
    verifyClient.start();
    client.newsService.register();
    client.autoDailyService.start();
    client.monitorService.register();
    // Leaderboard blob migration (once) and legacy-entry refresh (periodic).
    startGachaStorageJobs(client.startup, client.db);
    // client.wikiService.start();
  }
})().catch((error) => {
  // The process cannot do its job without a completed startup: let the manager respawn it.
  console.error("Fatal startup error:", error);
  process.exit(1);
});
