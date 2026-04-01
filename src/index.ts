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
import OptimizationManager from "./optimizations/index";

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

  // ====================================
  // 初始化優化功能
  // ====================================
  const optimizations = new OptimizationManager(client, client.db);
  await optimizations.initialize();
  (client as any).optimizations = optimizations.getManager();

  // Initialize WebManager and VerificationClient (will start later based on cluster)
  const webManager = new WebManager(client);
  const verifyClient = new VerificationClient(client);

  // 只有在 Cluster 0 啟動全域服務
  if (client.cluster.id === 0) {
    const logger = new Logger("Process");
    const webhook = process.env.ERRWEBHOOK
      ? new WebhookClient({ url: process.env.ERRWEBHOOK })
      : null;

    // ====================================
    // 設置統計數據推送到 personalWeb
    // ====================================
    const STATS_API = process.env.STATS_API_URL;
    const STATS_API_TOKEN = process.env.STATS_API_TOKEN;

    let statsInterval: NodeJS.Timeout | null = null;
    if (STATS_API && optimizations.commandUsageTracker) {
      statsInterval = setInterval(async () => {
        try {
          const stats = optimizations.commandUsageTracker?.getStats();
          if (stats && Object.keys(stats).length > 0) {
            // 計算聚合統計
            const totalCommands = Object.values(
              stats as Record<string, any>,
            ).reduce((sum: number, cmd: any) => sum + (cmd.count || 0), 0);
            const totalErrors = Object.values(
              stats as Record<string, any>,
            ).reduce((sum: number, cmd: any) => sum + (cmd.errors || 0), 0);

            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (STATS_API_TOKEN) {
              headers.Authorization = `Bearer ${STATS_API_TOKEN}`;
            }

            await fetch(STATS_API, {
              method: "POST",
              headers,
              body: JSON.stringify({
                botId: "endfield",
                botName: "Endfield",
                timestamp: Date.now(),
                stats: {
                  totalCommands24h: totalCommands,
                  totalErrors24h: totalErrors,
                  topCommands: Object.entries(stats as Record<string, any>)
                    .map(([name, data]: [string, any]) => ({
                      name,
                      count: data.count || 0,
                      avgTimeMs:
                        data.count > 0
                          ? Math.round(data.totalExecutionMs / data.count)
                          : 0,
                      errors: data.errors || 0,
                    }))
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 10),
                  byCommand: Object.entries(stats as Record<string, any>).map(
                    ([name, data]: [string, any]) => ({
                      name,
                      count: data.count || 0,
                      errors: data.errors || 0,
                      avgTimeMs:
                        data.count > 0
                          ? Math.round(data.totalExecutionMs / data.count)
                          : 0,
                    }),
                  ),
                },
              }),
            }).catch((err) => {
              logger.error(`Failed to push stats: ${err.message}`);
            });
          }
        } catch (error) {
          logger.error(`Error pushing stats: ${(error as Error).message}`);
        }
      }, 60_000);
    } else if (!STATS_API) {
      logger.error("STATS_API_URL is not set, stats push is disabled");
    }

    // 啟動服務
    webManager.start();
    verifyClient.start();
    client.newsService.start();
    client.autoDailyService.start();
    // client.monitorService.start();
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
