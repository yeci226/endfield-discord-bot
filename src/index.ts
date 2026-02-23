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
    webManager.start();
    verifyClient.start();
    client.newsService.start();
    client.autoDailyService.start();
    // client.monitorService.start();
    // client.wikiService.start();
  }

  // Process Error Handling
  const logger = new Logger("Process");
  const webhook = process.env.ERRWEBHOOK
    ? new WebhookClient({ url: process.env.ERRWEBHOOK })
    : null;

  process.on("unhandledRejection", async (reason: any, promise) => {
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
