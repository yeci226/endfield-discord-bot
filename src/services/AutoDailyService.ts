import { ExtendedClient } from "../structures/Client";
import {
  executeAttendance,
  formatSkGameRole,
  getAttendanceList,
} from "../utils/skportApi";
import {
  ensureAccountBinding,
  getAccounts,
  withAutoRefresh,
} from "../utils/accountUtils";
import { createTranslator } from "../utils/i18n";
import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MessageFlags,
} from "discord.js";
import moment from "moment-timezone";
import { Logger } from "../utils/Logger";

interface AutoDailyConfig {
  time: number; // 0-23
  auto_balance: boolean;
  notify: boolean;
  notify_method: "dm" | "channel";
  channelId?: string;
}

export class AutoDailyService {
  private client: ExtendedClient;
  private interval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private logger: Logger;

  constructor(client: ExtendedClient) {
    this.client = client;
    this.logger = new Logger("AutoDaily");
  }

  public start() {
    if (this.interval) return;

    // Check every minute to see if we hit the top of the hour (or close to it)
    // For simplicity, we can check every 1 minute and if minute == 0, run process.
    // Or better, calculate delay to next hour.

    this.scheduleNextRun();
    this.logger.success("Service started.");
  }

  private scheduleNextRun() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const msUtilNextHour = ((60 - minutes) * 60 - seconds) * 1000;

    // Add a small buffer to ensure we are definitely in the next hour
    this.interval = setTimeout(() => {
      this.runHourlyCheck();
      this.scheduleNextRun(); // Reschedule recursively
    }, msUtilNextHour + 1000);
  }

  public async manualRunRange(startHour: number, endHour: number) {
    this.logger.warn(
      `Manually running range: ${startHour}:00 to ${endHour}:00 (Asia/Taipei)`,
    );
    for (let h = startHour; h <= endHour; h++) {
      await this.runHourlyCheck(h);
    }
  }

  private async runHourlyCheck(targetHour?: number) {
    if (this.isRunning && targetHour === undefined) return;
    if (targetHour === undefined) this.isRunning = true;

    try {
      const currentHour =
        targetHour !== undefined
          ? targetHour
          : parseInt(moment().tz("Asia/Taipei").format("H"));
      this.logger.info(
        `Running checks for hour ${currentHour}:00 (Asia/Taipei)`,
      );

      const dailyData =
        ((await this.client.db.get("autoDaily")) as Record<
          string,
          AutoDailyConfig
        >) || {};

      const userIds = Object.keys(dailyData);
      const today = moment().tz("Asia/Taipei").format("YYYY-MM-DD");

      const eligibleUsers = [];
      for (const userId of userIds) {
        const config = dailyData[userId];
        if (config.time !== currentHour) continue;

        // Skip if already processed today
        const lastProcessed = await this.client.db.get(
          `${userId}.lastAutoDaily`,
        );
        if (lastProcessed === today) {
          // Skipping noisy user logs to keep it clean
          continue;
        }

        eligibleUsers.push(userId);
      }

      this.logger.info(`Found ${eligibleUsers.length} users for this hour.`);

      for (const userId of eligibleUsers) {
        await this.processUser(userId, dailyData[userId]);
      }
    } catch (error) {
      this.logger.error(
        "Error in hourly check: " +
          (error instanceof Error ? error.message : error),
      );
    } finally {
      this.isRunning = false;
    }
  }

  public async processUser(userId: string, config: AutoDailyConfig) {
    try {
      const accounts = await getAccounts(this.client.db, userId);
      if (!accounts || accounts.length === 0) return;

      let successCount = 0;
      let alreadySignedCount = 0;
      let failCount = 0;
      const results: {
        roleName: string;
        rewardName: string;
        rewardIcon: string;
        firstRewardName?: string;
        firstRewardIcon?: string;
        totalDays: number;
        status: string;
      }[] = [];

      const processedRoles = new Set<string>();

      const { toI18nLang } = require("../utils/i18n");
      const userLang = (await this.client.db.get(`${userId}.locale`)) || "tw";
      const tr = createTranslator(userLang);

      const { processRoleAttendance } = require("../utils/attendanceUtils");

      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        if (account.invalid) {
          this.logger.warn(
            `Skipping invalid account for user ${userId}: ${account.info?.nickname} (${account.info?.id})`,
          );
          results.push({
            roleName: `${account.info?.nickname || "Unknown"} (Account Invalid)`,
            rewardName: "",
            rewardIcon: "",
            totalDays: 0,
            status: tr("TokenExpired"),
          });
          failCount++;
          continue;
        }

        await ensureAccountBinding(account, userId, this.client.db, tr.lang);

        const roles = account.roles;
        if (!roles || roles.length === 0) continue;

        for (const binding of roles) {
          for (const role of binding.roles) {
            const gameId = binding.gameId || 3;
            const gameRoleStr = formatSkGameRole(
              gameId,
              role.roleId,
              role.serverId,
            );

            if (processedRoles.has(gameRoleStr)) continue;
            processedRoles.add(gameRoleStr);

            const res: any = await withAutoRefresh(
              this.client,
              userId,
              account,
              (c: string, s: string, opt: any) =>
                processRoleAttendance(
                  role,
                  gameId,
                  account.cookie,
                  tr.lang,
                  c,
                  s,
                  true,
                  tr,
                  opt,
                ),
              tr.lang,
            );

            if (res) {
              if (res.signedNow) successCount++;
              else if (res.hasToday) alreadySignedCount++;
              else if (res.error) failCount++;

              // Support multi-line rewards from Python logic
              const displayedReward = res.rewardName || tr("None");

              results.push({
                roleName: `${res.nickname} (Lv.${res.level})`,
                rewardName: displayedReward,
                rewardIcon: res.rewardIcon,
                firstRewardName: res.firstRewardName,
                totalDays: res.totalDays,
                status: res.signedNow
                  ? tr("daily_Success")
                  : tr("daily_StatusAlready"),
              });
            }
          }
        }
      }

      // Mark as processed for today
      const today = moment().tz("Asia/Taipei").format("YYYY-MM-DD");
      await this.client.db.set(`${userId}.lastAutoDaily`, today);

      if (config.notify && (successCount > 0 || alreadySignedCount > 0)) {
        const container = new ContainerBuilder();
        for (const res of results) {
          let content = `# **${res.roleName}** - ${res.status}\n### ${tr("daily_TodayReward")}: \`${res.rewardName}\``;

          if (res.firstRewardName) {
            content += `\n### ${tr("daily_FirstReward")}: \`${res.firstRewardName}\``;
          }

          content += `\n### ${tr("daily_TotalDays")}: \`${res.totalDays}\` ${tr("Day")}`;

          const textDisplay = new TextDisplayBuilder().setContent(content);

          if (res.rewardIcon) {
            const section = new SectionBuilder()
              .addTextDisplayComponents(textDisplay)
              .setThumbnailAccessory(
                new ThumbnailBuilder({ media: { url: res.rewardIcon } }),
              );
            container.addSectionComponents(section);
          } else {
            container.addTextDisplayComponents(textDisplay);
          }
        }

        const payload = {
          content: "",
          flags: MessageFlags.IsComponentsV2,
          components: [container],
        };

        const notifyMethod = config.notify_method;
        const channelId = config.channelId;

        try {
          await this.client.cluster.broadcastEval(
            async (c: any, context: any) => {
              try {
                if (context.notifyMethod === "dm") {
                  const user = c.users.cache.get(context.userId);
                  if (user) {
                    await user.send(context.payload);
                    return true;
                  }
                } else if (
                  context.notifyMethod === "channel" &&
                  context.channelId
                ) {
                  const channel = c.channels.cache.get(context.channelId);
                  if (channel) {
                    await channel.send(context.payload);
                    return true;
                  }
                }
              } catch (e) {}
              return false;
            },
            {
              context: {
                userId,
                payload,
                notifyMethod,
                channelId,
              },
            },
          );
        } catch (e) {
          this.logger.error(
            "Failed to broadcast notification: " +
              (e instanceof Error ? e.message : e),
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Error processing user ${userId}: ` +
          (error instanceof Error ? error.message : error),
      );
    }
  }

  // Helper for auto-balance logic
  public async getBalancedHour(): Promise<number> {
    const dailyData =
      ((await this.client.db.get("autoDaily")) as Record<
        string,
        AutoDailyConfig
      >) || {};
    const hourCounts = new Array(24).fill(0);

    Object.values(dailyData).forEach((conf) => {
      if (conf.time >= 0 && conf.time < 24) {
        hourCounts[conf.time]++;
      }
    });

    // Find index of min value
    let minIdx = 0;
    let minVal = hourCounts[0];
    for (let i = 1; i < 24; i++) {
      if (hourCounts[i] < minVal) {
        minVal = hourCounts[i];
        minIdx = i;
      }
    }

    return minIdx;
  }

  private async sendNotification(
    userId: string,
    config: AutoDailyConfig,
    payload: any,
  ) {
    const notifyMethod = config.notify_method;
    const channelId = config.channelId;

    try {
      await this.client.cluster.broadcastEval(
        async (c: any, context: any) => {
          try {
            if (context.notifyMethod === "dm") {
              const user = c.users.cache.get(context.userId);
              if (user) {
                await user.send(context.payload);
                return true;
              }
            } else if (
              context.notifyMethod === "channel" &&
              context.channelId
            ) {
              const channel = c.channels.cache.get(context.channelId);
              if (channel) {
                await channel.send(context.payload);
                return true;
              }
            }
          } catch (e) {}
          return false;
        },
        {
          context: {
            userId,
            payload,
            notifyMethod,
            channelId,
          },
        },
      );
    } catch (e) {
      this.logger.error(
        "Failed to broadcast notification: " +
          (e instanceof Error ? e.message : e),
      );
    }
  }
}
