/**
 * 機器人優化配置
 * 包括命令統計、速率限制、超時和重試、錯誤處理
 */

export const OPTIMIZATION_CONFIG = {
  // 命令使用統計
  commandUsageTracker: {
    enabled: true,
    flushIntervalMs: 60_000, // 每 60 秒 flush 一次統計
    persistToDb: true, // 保存到數據庫
  },

  // 全局速率限制
  rateLimiter: {
    enabled: true,
    maxRequestsPerSecond: 100, // 全局最多 100 req/s
    userMaxPerMinute: 30, // 用戶最多 30 req/min
  },

  // 命令執行超時和重試
  commandExecutor: {
    enabled: true,
    defaultTimeoutMs: 30_000, // 30秒超時
    maxRetries: 2, // 失敗時重試 2 次
    retryDelayMs: 1000, // 初始重試延遲 1 秒（指數級增長）
  },

  // 消息緩存
  messageCache: {
    enabled: true,
    ttlMs: 3600_000, // 緩存 1 小時
    maxSize: 10_000, // 最多 10,000 消息
  },

  // 強化錯誤處理
  errorHandler: {
    enabled: true,
    logToWebhook: true, // 發送到 Discord webhook
    captureStack: true,
  },

  // 數據庫連接池（如果使用 SQLite）
  connectionPool: {
    enabled: false, // 根據需要啟用
    minConnections: 2,
    maxConnections: 10,
    idleTimeoutMs: 30_000,
  },
};

export default OPTIMIZATION_CONFIG;
