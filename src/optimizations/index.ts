/**
 * 機器人優化初始化器
 * 初始化所有優化工具：命令統計、速率限制、超時/重試、緩存等
 */

import { Logger } from "../utils/Logger";
import OPTIMIZATION_CONFIG from "./config";
import {
  CommandUsageTracker,
  RateLimiter,
  CommandExecutor,
  MessageCache,
  EnhancedErrorHandler,
  ConnectionPool,
} from "../utils/sharedCompat";

const logger = new Logger("Optimization");

export class OptimizationManager {
  commandUsageTracker?: CommandUsageTracker;
  rateLimiter?: RateLimiter;
  commandExecutor?: CommandExecutor;
  messageCache?: MessageCache;
  errorHandler?: EnhancedErrorHandler;
  connectionPool?: ConnectionPool;

  client: any;
  db: any;

  constructor(client: any, db: any) {
    this.client = client;
    this.db = db;
  }

  async initialize() {
    logger.info("Initializing optimizations...");

    // 1. 命令使用統計追蹤
    if (OPTIMIZATION_CONFIG.commandUsageTracker.enabled) {
      this.commandUsageTracker = new CommandUsageTracker(
        OPTIMIZATION_CONFIG.commandUsageTracker.flushIntervalMs
      );

      // 設置 flush 回調，定期保存統計到數據庫
      this.commandUsageTracker.onFlush(async (stats) => {
        try {
          const timestamp = Date.now();
          await this.db.set(`stats.commands.${timestamp}`, stats);
          logger.success(
            `✓ Command stats saved (${Object.keys(stats).length} commands)`
          );
        } catch (error) {
          logger.error(
            `❌ Failed to save command stats: ${(error as Error).message}`
          );
        }
      });

      logger.success("✓ Command usage tracker initialized");
    }

    // 2. 全局速率限制
    if (OPTIMIZATION_CONFIG.rateLimiter.enabled) {
      this.rateLimiter = new RateLimiter({
        maxRequestsPerSecond:
          OPTIMIZATION_CONFIG.rateLimiter.maxRequestsPerSecond,
        userMaxPerMinute: OPTIMIZATION_CONFIG.rateLimiter.userMaxPerMinute,
      });

      logger.success("✓ Rate limiter initialized");
    }

    // 3. 命令執行器（超時 + 重試）
    if (OPTIMIZATION_CONFIG.commandExecutor.enabled) {
      this.commandExecutor = new CommandExecutor({
        defaultTimeoutMs: OPTIMIZATION_CONFIG.commandExecutor.defaultTimeoutMs,
        maxRetries: OPTIMIZATION_CONFIG.commandExecutor.maxRetries,
        retryDelayMs: OPTIMIZATION_CONFIG.commandExecutor.retryDelayMs,
        logger: logger as any,
      });

      logger.success("✓ Command executor (timeout + retry) initialized");
    }

    // 4. 消息緩存
    if (OPTIMIZATION_CONFIG.messageCache.enabled) {
      this.messageCache = new MessageCache({
        ttlMs: OPTIMIZATION_CONFIG.messageCache.ttlMs,
        maxSize: OPTIMIZATION_CONFIG.messageCache.maxSize,
      });

      logger.success("✓ Message cache initialized");
    }

    // 5. 強化錯誤處理
    if (OPTIMIZATION_CONFIG.errorHandler.enabled) {
      this.errorHandler = new EnhancedErrorHandler({ logger: logger as any });

      // 設置錯誤回調，發送到 Discord webhook
      if (OPTIMIZATION_CONFIG.errorHandler.logToWebhook && process.env.ERRWEBHOOK) {
        const { WebhookClient } = await import("discord.js");
        const webhook = new WebhookClient({ url: process.env.ERRWEBHOOK });

        this.errorHandler.onError(async (errorData) => {
          try {
            await webhook.send({
              embeds: [
                {
                  title: "❌ Command Execution Error",
                  description: errorData.message,
                  fields: [
                    { name: "Code", value: errorData.code || "N/A", inline: true },
                    {
                      name: "Source",
                      value: errorData.context?.source || "Unknown",
                      inline: true,
                    },
                    { name: "Time", value: errorData.timestamp, inline: false },
                  ],
                  color: 0xff0000,
                  timestamp: new Date().toISOString(),
                },
              ],
            });
          } catch {
            // Ignore webhook errors
          }
        });
      }

      logger.success("✓ Enhanced error handler initialized");
    }

    // 6. 數據庫連接池（如果使用）
    if (OPTIMIZATION_CONFIG.connectionPool.enabled) {
      logger.info("ℹ Connection pool not enabled in this configuration");
    }

    logger.success(`✅ All optimizations initialized`);
  }

  getManager() {
    return {
      commandUsageTracker: this.commandUsageTracker,
      rateLimiter: this.rateLimiter,
      commandExecutor: this.commandExecutor,
      messageCache: this.messageCache,
      errorHandler: this.errorHandler,
      connectionPool: this.connectionPool,
    };
  }

  async shutdown() {
    logger.info("Shutting down optimization manager...");

    if (this.commandUsageTracker) {
      this.commandUsageTracker.stop();
    }

    if (this.connectionPool) {
      await this.connectionPool.close();
    }

    logger.success("✅ Optimization manager shut down");
  }
}

export default OptimizationManager;
