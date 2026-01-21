import { ExtendedClient } from "./structures/Client";
import { loadCommands } from "./handlers/commandHandler";
import { loadEvents } from "./handlers/eventHandler";
import { SkportNewsService } from "./services/SkportNewsService";

(async () => {
  const client = new ExtendedClient();
  client.newsService = new SkportNewsService(client);

  await loadCommands(client);
  await loadEvents(client);
  client.start();
  client.newsService.start();

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
