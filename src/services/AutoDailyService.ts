import { ExtendedClient } from "../structures/Client";
import {
  getGamePlayerBinding,
  executeAttendance,
  formatSkGameRole,
  getAttendanceList,
} from "../utils/skportApi";
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
      const accounts = (await this.client.db.get(
        `${userId}.accounts`,
      )) as any[];
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

      for (const account of accounts) {
        const bindings = await getGamePlayerBinding(
          account.cookie,
          undefined,
          account.cred,
        );
        if (!bindings) {
          failCount++;
          continue;
        }

        const endfieldApp = bindings.find((b) => b.appCode === "endfield");
        if (!endfieldApp) continue;

        for (const binding of endfieldApp.bindingList) {
          for (const role of binding.roles) {
            const gameRole = formatSkGameRole(
              binding.gameId,
              role.roleId,
              role.serverId,
            );

            if (processedRoles.has(gameRole)) continue;
            processedRoles.add(gameRole);

            const status = await getAttendanceList(
              gameRole,
              account.cookie,
              undefined,
              account.cred,
            );
            if (status) {
              let signedNow = false;
              if (!status.hasToday) {
                const result = await executeAttendance(
                  gameRole,
                  account.cookie,
                  undefined,
                  account.cred,
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
                    undefined,
                    account.cred,
                  )
                : status;
              const totalDays =
                finalStatus?.calendar.filter((d) => d.done).length || 0;
              const todayReward =
                finalStatus?.calendar.find((d) => d.available) ||
                finalStatus?.calendar.find((d) => d.done); // Adjust based on logic

              let rewardName = "未知獎勵";
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
              // "first" array logic: check if any item is done/available corresponding to this check-in
              // Since we don't know the exact day index easily without more logic, we check for available or done in the 'first' list
              // that matches the current context. However, 'first' usually has 3 items.
              // We'll check if there is a 'first' reward that is available or done TODAY.
              // Note: 'done' in 'first' might stay true forever. We only want to show it if it was JUST done or is available today.
              // But 'finalStatus' reflects the state AFTER check-in.
              // If we just signed in (signedNow=true), 'done' will be true for the current day.
              // If we are just checking, 'available' might be true if not signed yet.

              // Filter for the specific first reward that corresponds to the current progress.
              // Currently, we just look for the one that is 'done' (if signedNow) or 'available'.
              // But since previous ones are also 'done', we need to be careful.
              // Actually, for simplicity in "Today's Status", we can check if the user is within the first 3 days.
              // But easier: check if `finalStatus.first` has an item that matches the criteria.

              if (finalStatus?.first) {
                // If we successfully signed TODAY, we look for the reward that corresponds to today's cumulative count.
                // The 'first' array usually has 3 items.
                // If totalDays is 1 -> first[0], 2 -> first[1], 3 -> first[2].
                // Let's protect bounds.
                if (totalDays >= 1 && totalDays <= 3) {
                  const fReward = finalStatus.first[totalDays - 1];
                  if (fReward && (fReward.done || fReward.available)) {
                    const res = finalStatus.resourceInfoMap[fReward.awardId];
                    if (res) {
                      firstRewardName = `${res.name} x${res.count}`;
                      // specific icon for first reward or just keep daily one?
                      // Requirements say "Also display it".
                      if (!rewardIcon) firstRewardIcon = res.icon; // Fallback if daily has no icon?
                    }
                  }
                }
              }

              results.push({
                roleName: `${role.nickname} (Lv.${role.level})`,
                rewardName,
                rewardIcon,
                firstRewardName,
                totalDays,
                status: signedNow ? "成功簽到" : "已簽到",
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
          let content = `# **${res.roleName}** - ${res.status}\n### 今日獎勵: \`${res.rewardName}\``;

          if (res.firstRewardName) {
            content += `\n### 新人獎勵: \`${res.firstRewardName}\``;
          }

          content += `\n### 累計簽到: \`${res.totalDays}\` 天`;

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

        if (config.notify_method === "dm") {
          try {
            const user = await this.client.users.fetch(userId);
            if (user) {
              await user.send({
                content: "",
                flags: MessageFlags.IsComponentsV2,
                components: [container],
              });
            }
          } catch (e) {
            // Fallback to channel if DM fails
            if (config.channelId) {
              const channel = (await this.client.channels.fetch(
                config.channelId,
              )) as TextChannel;
              if (channel)
                await channel.send({
                  content: "",
                  flags: MessageFlags.IsComponentsV2,
                  components: [container],
                });
            }
          }
        } else if (config.notify_method === "channel" && config.channelId) {
          const channel = (await this.client.channels.fetch(
            config.channelId,
          )) as TextChannel;
          if (channel)
            await channel.send({
              content: "",
              flags: MessageFlags.IsComponentsV2,
              components: [container],
            });
        }
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
