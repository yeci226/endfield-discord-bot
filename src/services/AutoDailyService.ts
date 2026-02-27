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
import { processRoleAttendance } from "../utils/attendanceUtils";

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

  public async start() {
    if (this.interval) return;

    // Immediately run check for current hour to catch missed tasks during restart
    await this.runHourlyCheck();

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

      // Migrate to prefixed keys
      const dailyUsers =
        await this.client.db.findByPrefix<AutoDailyConfig>("autoDaily.");

      const today = moment().tz("Asia/Taipei").format("YYYY-MM-DD");

      const eligibleUsers = [];
      for (const { id, value: config } of dailyUsers) {
        const userId = id.replace("autoDaily.", "");
        if (config.time !== currentHour) continue;

        // Skip if already processed today
        const lastProcessed = await this.client.db.get(
          `${userId}.lastAutoDaily`,
        );
        if (lastProcessed === today) {
          continue;
        }

        eligibleUsers.push({ userId, config });
      }

      this.logger.info(`Found ${eligibleUsers.length} users for this hour.`);

      for (const { userId, config } of eligibleUsers) {
        await this.processUser(userId, config);
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
      this.logger.info(`Starting auto-daily processing for user ${userId}`);
      const results: {
        roleName: string;
        rewardName: string;
        rewardIcon: string;
        firstRewardName?: string;
        firstRewardIcon?: string;
        totalDays: number;
        status: string;
        isError?: boolean;
      }[] = [];

      const processedRoles = new Set<string>();

      const userLang = (await this.client.db.get(`${userId}.locale`)) || "tw";
      const tr = createTranslator(userLang);

      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        if (account.invalid) {
          this.logger.warn(
            `Skipping invalid account for user ${userId}: ${account.info?.nickname} (${account.info?.id})`,
          );
          results.push({
            roleName: `${account.info?.nickname || "Unknown"}`,
            rewardName: "",
            rewardIcon: "",
            totalDays: 0,
            status: tr("TokenExpired"),
            isError: true,
          });
          failCount++;
          continue;
        }

        try {
          await ensureAccountBinding(account, userId, this.client.db, tr.lang);

          const roles = account.roles;
          if (!roles || roles.length === 0) {
            results.push({
              roleName: `${account.info?.nickname || "Unknown"}`,
              rewardName: "",
              rewardIcon: "",
              totalDays: 0,
              status: tr("Error") || "No roles found",
              isError: true,
            });
            failCount++;
            continue;
          }

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

              try {
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
                    isError: !!res.error && !res.signedNow && !res.hasToday,
                  });

                  this.logger.info(
                    `User ${userId} - Role ${res.nickname} (${res.uid}): ${res.signedNow ? "SUCCESS" : res.hasToday ? "ALREADY SIGNED" : "ERROR"}` +
                      (res.signedNow ? ` (Reward: ${displayedReward})` : ""),
                  );
                }
              } catch (roleError) {
                this.logger.error(
                  `Error processing role ${gameRoleStr} for user ${userId}: ${roleError}`,
                );
                results.push({
                  roleName: `${role.nickname || "Unknown"}`,
                  rewardName: "",
                  rewardIcon: "",
                  totalDays: 0,
                  status: tr("Error"),
                  isError: true,
                });
                failCount++;
              }
            }
          }
        } catch (accError) {
          this.logger.error(
            `Error processing account ${account.info?.id} for user ${userId}: ${accError}`,
          );
          results.push({
            roleName: `${account.info?.nickname || "Unknown"}`,
            rewardName: "",
            rewardIcon: "",
            totalDays: 0,
            status: tr("Error"),
            isError: true,
          });
          failCount++;
        }
      }

      this.logger.info(
        `Finished auto-daily for user ${userId}. Result: ${successCount} success, ${alreadySignedCount} already signed, ${failCount} failed.`,
      );

      // Mark as processed for today
      const today = moment().tz("Asia/Taipei").format("YYYY-MM-DD");
      await this.client.db.set(`${userId}.lastAutoDaily`, today);

      if (config.notify && results.length > 0) {
        const container = new ContainerBuilder();
        for (const res of results) {
          const statusPrefix = res.isError ? "❌" : "✅";
          let content = `# **${statusPrefix} ${res.roleName}** - ${res.status}`;

          if (!res.isError) {
            content += `\n### ${tr("daily_TodayReward")}: \`${res.rewardName}\``;

            if (res.firstRewardName) {
              content += `\n### ${tr("daily_FirstReward")}: \`${res.firstRewardName}\``;
            }

            content += `\n### ${tr("daily_TotalDays")}: \`${res.totalDays}\` ${tr("Day")}`;
          }

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
                  let user = c.users.cache.get(context.userId);
                  if (!user) {
                    try {
                      user = await c.users.fetch(context.userId);
                    } catch (e) {
                      return false;
                    }
                  }
                  if (user) {
                    const dmChannel = await user.createDM();
                    await dmChannel.send(context.payload);
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
    const dailyUsers =
      await this.client.db.findByPrefix<AutoDailyConfig>("autoDaily.");
    const hourCounts = new Array(24).fill(0);

    dailyUsers.forEach(({ value: conf }) => {
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
              let user = c.users.cache.get(context.userId);
              if (!user) {
                try {
                  user = await c.users.fetch(context.userId);
                } catch (e) {
                  return false;
                }
              }
              if (user) {
                const dmChannel = await user.createDM();
                await dmChannel.send(context.payload);
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
