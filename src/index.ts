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

dotenv.config();

(async () => {
  const client = new ExtendedClient();
  startTelemetry(client, client.cluster, 'endfield', 'Endfield', process.env.JLWEBHOOK);
  client.newsService = new SkportNewsService(client);
  client.autoDailyService = new AutoDailyService(client);
  client.monitorService = new MonitorService(client);
  client.wikiService = new CharacterWikiService(client);

  await loadCommands(client);
  await loadEvents(client);
  client.start();

  // Initialize WebManager and VerificationClient (will start later based on cluster)
  const webManager = new WebManager(client);
  const verifyClient = new VerificationClient(client);

  // 只有在 Cluster 0 啟動全域服務
  if (client.cluster.id === 0) {
    const logger = new Logger("Process");
    const webhook = process.env.ERRWEBHOOK
      ? new WebhookClient({ url: process.env.ERRWEBHOOK })
      : null;

    // 啟動服務
    webManager.start();
    verifyClient.start();
    client.newsService.start();
    client.autoDailyService.start();
    client.monitorService.start();
    // client.wikiService.start();

    // Re-expose logger and webhook for the unhandled handlers below
    (global as any).processLogger = logger;
    (global as any).processWebhook = webhook;
  }

  process.on("unhandledRejection", async (reason: any, promise) => {
    const logger = (global as any).processLogger || new Logger("Process");
    const webhook = (global as any).processWebhook;
    logger.error(`Unhandled Rejection: ${reason}`);
    logger.error(reason);
    if (webhook) {
      try {
        await webhook.send({
          embeds: [
            {
              title: "🚨 **Unhandled Rejection**",
              description: `\`\`\`${reason.stack || reason}\`\`\``,
              color: 0xff0000,
            },
          ],
        });
      } catch (e) {
        logger.error("Failed to send webhook", e);
      }
    }
  });

  process.on("uncaughtException", async (error: Error) => {
    const logger = (global as any).processLogger || new Logger("Process");
    const webhook = (global as any).processWebhook;
    logger.error(`Uncaught Exception: ${error.message}`);
    logger.error(error);
    if (webhook) {
      try {
        await webhook.send({
          embeds: [
            {
              title: "🚨 **Uncaught Exception**",
              description: `\`\`\`${error.stack || error.message}\`\`\``,
              color: 0xff0000,
            },
          ],
        });
      } catch (e) {
        logger.error("Failed to send webhook", e);
      }
    }
  });
})();
