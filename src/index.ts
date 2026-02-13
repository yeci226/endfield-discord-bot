import { ExtendedClient } from "./structures/Client";
import { loadCommands } from "./handlers/commandHandler";
import { loadEvents } from "./handlers/eventHandler";
import { SkportNewsService } from "./services/SkportNewsService";
import { AutoDailyService } from "./services/AutoDailyService";
import { VerificationClient } from "./web/VerificationClient";
import { CharacterWikiService } from "./services/CharacterWikiService";
import { WebManager } from "./web/WebManager";

(async () => {
  const client = new ExtendedClient();
  client.newsService = new SkportNewsService(client);
  client.autoDailyService = new AutoDailyService(client);
  client.wikiService = new CharacterWikiService(client);

  await loadCommands(client);
  await loadEvents(client);
  client.start();

  // Initialize WebManager
  const webManager = new WebManager(client);
  webManager.start();

  // Initialize VerificationClient on all clusters for session registration
  const verifyClient = new VerificationClient(client);
  verifyClient.start();

  // 只有在 Cluster 0 啟動全域服務
  if (client.cluster.id === 0) {
    client.newsService.start();
    client.autoDailyService.start();
    // client.wikiService.start();
  }

  // Process Error Handling
  const { WebhookClient } = require("discord.js");
  const { Logger } = require("./utils/Logger");
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
