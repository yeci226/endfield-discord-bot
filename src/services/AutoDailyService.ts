import { ExtendedClient } from "../structures/Client";
import {
  getGamePlayerBinding,
  executeAttendance,
  formatSkGameRole,
  getAttendanceList,
  verifyToken,
} from "../utils/skportApi";
import { extractAccountToken } from "../commands/account/login";
import { ensureAccountBinding, getAccounts } from "../utils/accountUtils";
import {
  EmbedBuilder,
  TextChannel,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MessageFlags,
} from "discord.js";
import moment from "moment-timezone";
import colors from "colors";

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

  constructor(client: ExtendedClient) {
    this.client = client;
  }

  public start() {
    if (this.interval) return;

    // Check every minute to see if we hit the top of the hour (or close to it)
    // For simplicity, we can check every 1 minute and if minute == 0, run process.
    // Or better, calculate delay to next hour.

    this.scheduleNextRun();
    console.log(colors.green("[AutoDaily] Service started."));
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

  private async runHourlyCheck() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const currentHour = parseInt(moment().tz("Asia/Taipei").format("H"));
      console.log(
        colors.blue(
          `[AutoDaily] Running checks for hour ${currentHour}:00 (Asia/Taipei)`,
        ),
      );

      const dailyData =
        ((await this.client.db.get("autoDaily")) as Record<
          string,
          AutoDailyConfig
        >) || {};

      const userIds = Object.keys(dailyData);
      const eligibleUsers = userIds.filter((userId) => {
        const config = dailyData[userId];
        // If auto_balance is true, we need to dynamically determine if this is their slot.
        // BUT, the plan said "Save/Update ... to autoDaily".
        // If auto_balance is ON, we should probably have pre-calculated their assigned slot or calculate it now.
        // For simplicity and stability, let's assume 'time' is the definitive source of truth,
        // and 'auto_balance' logic happens during 'setup' command execution to set that 'time'.
        // So here we valid check 'time'.
        return config.time === currentHour;
      });

      console.log(
        colors.cyan(
          `[AutoDaily] Found ${eligibleUsers.length} users for this hour.`,
        ),
      );

      for (const userId of eligibleUsers) {
        await this.processUser(userId, dailyData[userId]);
      }
    } catch (error) {
      console.error(colors.red("[AutoDaily] Error in hourly check:"), error);
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

      const { createTranslator, toI18nLang } = require("../utils/i18n");
      const userLang = (await this.client.db.get(`${userId}.locale`)) || "tw";
      const tr = createTranslator(userLang);

      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        // AUTO-MIGRATION & REBIND LOGIC
        await ensureAccountBinding(account, userId, this.client.db, tr.lang);

        // Use stored roles
        const roles = account.roles;
        if (!roles || roles.length === 0) continue;

        for (const binding of roles) {
          for (const role of binding.roles) {
            const gameRole = formatSkGameRole(
              binding.gameId || 1,
              role.roleId,
              role.serverId,
            );

            if (processedRoles.has(gameRole)) continue;
            processedRoles.add(gameRole);

            const status = await getAttendanceList(
              gameRole,
              account.cookie,
              tr.lang,
              account.cred,
              account.salt,
            );
            if (status) {
              let signedNow = false;
              if (!status.hasToday) {
                const result = await executeAttendance(
                  gameRole,
                  account.cookie,
                  tr.lang,
                  account.cred,
                  account.salt,
                );
                if (result && result.code === 0) {
                  signedNow = true;
                  successCount++;
                } else {
                  failCount++;
                }
              } else {
                alreadySignedCount++;
              }

              // Re-fetch or update status to get correct 'done' days if signed
              const finalStatus = signedNow
                ? await getAttendanceList(
                    gameRole,
                    account.cookie,
                    tr.lang,
                    account.cred,
                    account.salt,
                  )
                : status;
              const totalDays =
                finalStatus?.calendar.filter((d) => d.done).length || 0;
              const todayReward =
                finalStatus?.calendar.find((d) => d.available) ||
                [...(finalStatus?.calendar || [])]
                  .reverse()
                  .find((d) => d.done); // Pick the latest 'done' item if none are available

              let rewardName = tr("None");
              let rewardIcon = "";
              if (todayReward) {
                const res = finalStatus?.resourceInfoMap[todayReward.awardId];
                if (res) {
                  rewardName = `${res.name} x${res.count}`;
                  rewardIcon = res.icon;
                }
              }

              // First Reward Logic
              let firstRewardName = "";
              let firstRewardIcon = "";

              if (finalStatus?.first) {
                // Strict check: Only show if explicitly available or done (and we just signed?)
                // Actually, for auto-daily, we just want to show if it's relevant.
                // Avoid the "1-3 days monthly" trap.
                const availableFirst = finalStatus.first.find(
                  (f) => f.available || f.done,
                );
                // Note: f.done might be true for old rewards if we just iterate all.
                // But usually 'first' array filters down or we only care if we just claimed it.
                // If we just claimed it, it should satisfy 'done'.
                // However, if we look at `daily.ts`, we used strict find.

                const targetFirst = finalStatus.first.find((f) => f.available);
                // If we auto-claimed, it might be marked done now.
                // We can try to match the awardId if we really wanted, but for now let's just use the strict availability
                // or if we signed successfully, maybe we check if any 'first' reward matches the day?
                // SAFEST FIX: Only show if we find one that is AVAILABLE (before claim) or maybe we can't easily track "just claimed newcomer" without extra logic.
                // But definitely REMOVE the `totalDays >= 1 && totalDays <= 3` check which causes the bug.

                if (targetFirst) {
                  const res = finalStatus.resourceInfoMap[targetFirst.awardId];
                  if (res) {
                    firstRewardName = `${res.name} x${res.count}`;
                    if (!rewardIcon) firstRewardIcon = res.icon;
                  }
                }
              }

              results.push({
                roleName: `${role.nickname} (Lv.${role.level})`,
                rewardName,
                rewardIcon,
                firstRewardName,
                totalDays,
                status: signedNow
                  ? tr("daily_Success")
                  : tr("daily_StatusAlready"),
              });
            } else {
              failCount++;
            }
          }
        }
      }

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
      }
    } catch (error) {
      console.error(
        colors.red(`[AutoDaily] Error processing user ${userId}:`),
        error,
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
}
