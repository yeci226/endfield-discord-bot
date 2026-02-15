import { ExtendedClient } from "../structures/Client";
import { getCardDetail } from "../utils/skportApi";
import { getAccounts, withAutoRefresh } from "../utils/accountUtils";
import { createTranslator } from "../utils/i18n";
import { Logger } from "../utils/Logger";
import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from "discord.js";
import moment from "moment-timezone";

interface MonitorConfig {
  stamina_notify: boolean;
  stamina_offset: number; // Distance to max stamina (e.g. 10 means notify when 10 away from full)
  mission_notify: boolean;
  notify_method: "dm" | "channel";
  channelId?: string;
}

export class MonitorService {
  private client: ExtendedClient;
  private interval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private logger: Logger;

  constructor(client: ExtendedClient) {
    this.client = client;
    this.logger = new Logger("Monitor");
  }

  public start() {
    if (this.interval) return;

    // Check every hour for stamina and missions
    // We could make this more frequent, but once an hour is usually fine for "nearing full"
    this.scheduleNextRun();
    this.logger.success("Service started.");
  }

  private scheduleNextRun() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const msUtilNextHour = ((60 - minutes) * 60 - seconds) * 1000;

    this.interval = setTimeout(() => {
      this.runMonitoring();
      this.scheduleNextRun();
    }, msUtilNextHour + 2000);
  }

  public async runMonitoring() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const monitorData =
        ((await this.client.db.get("monitorConfig")) as Record<
          string,
          MonitorConfig
        >) || {};
      const userIds = Object.keys(monitorData);

      this.logger.info(`Checking status for ${userIds.length} users...`);

      for (const userId of userIds) {
        const config = monitorData[userId];
        if (config.stamina_notify || config.mission_notify) {
          await this.monitorUser(userId, config);
        }
      }
    } catch (error) {
      this.logger.error("Error in monitoring loop: " + error);
    } finally {
      this.isRunning = false;
    }
  }

  private async monitorUser(userId: string, config: MonitorConfig) {
    try {
      const accounts = await getAccounts(this.client.db, userId);
      if (!accounts || accounts.length === 0) return;

      const userLang = (await this.client.db.get(`${userId}.locale`)) || "tw";
      const tr = createTranslator(userLang);

      for (const account of accounts) {
        if (account.invalid) continue;

        const roles = account.roles;
        if (!roles || roles.length === 0) continue;

        const role = roles[0]?.roles?.[0]; // Monitor primary role
        if (!role) continue;

        const cardRes = (await withAutoRefresh(
          this.client,
          userId,
          account,
          (c, s) =>
            getCardDetail(
              role.roleId,
              role.serverId,
              account.info?.id || role.roleId,
              tr.lang,
              c,
              s,
            ),
          tr.lang,
        )) as any;

        if (!cardRes || cardRes.code !== 0 || !cardRes.data?.detail) continue;
        const detail = cardRes.data.detail;

        // 1. Stamina Monitoring
        if (config.stamina_notify) {
          const dungeon = detail.dungeon;
          const cur = parseInt(dungeon.curStamina);
          const max = parseInt(dungeon.maxStamina);
          const offset = config.stamina_offset || 10;
          const threshold = max - offset;

          const lastStaminaNotify = await this.client.db.get(
            `${userId}.lastStaminaNotify.${role.roleId}`,
          );
          const nowTs = Date.now();

          // Notify if crossed threshold and not already notified in the last 4 hours
          if (
            cur >= threshold &&
            (!lastStaminaNotify || nowTs - lastStaminaNotify > 4 * 3600 * 1000)
          ) {
            const isFull = cur >= max;
            const fullTime =
              dungeon.maxTs !== "0" ? parseInt(dungeon.maxTs) : 0;

            const container = new ContainerBuilder();
            let content = `## **${role.nickname}** - ${tr("stamina_Notify_Title")}\n`;
            content += `### ${tr("monitor_Notify_Stamina_Now")} \`${cur}/${max}\` \n`;

            if (isFull) {
              content += `### ${tr("monitor_Notify_Stamina_Full")} \`${tr("stamina_Capped")}\``;
            } else if (fullTime > 0) {
              content += `### ${tr("monitor_Notify_Stamina_Full")} <t:${fullTime}:f> (<t:${fullTime}:R>)`;
            }

            container.addTextDisplayComponents(
              new TextDisplayBuilder().setContent(content),
            );

            await this.sendNotification(userId, config, {
              flags: MessageFlags.IsComponentsV2,
              components: [container],
            });
            await this.client.db.set(
              `${userId}.lastStaminaNotify.${role.roleId}`,
              nowTs,
            );
          }
        }

        // 2. Daily Mission Reminders
        if (config.mission_notify) {
          const mission = detail.dailyMission;
          const cur = mission.dailyActivation;
          const max = mission.maxDailyActivation;
          const nowTs = Date.now();

          const nowTaipei = moment().tz("Asia/Taipei");
          let resetTime = moment()
            .tz("Asia/Taipei")
            .hour(4)
            .minute(0)
            .second(0);
          if (nowTaipei.isAfter(resetTime)) {
            resetTime.add(1, "day");
          }

          const hoursToReset = resetTime.diff(nowTaipei, "hours", true);

          if (cur < max && hoursToReset <= 3) {
            const lastMissionNotify = await this.client.db.get(
              `${userId}.lastMissionNotify.${role.roleId}_${resetTime.format("YYYY-MM-DD")}`,
            );

            if (!lastMissionNotify) {
              const container = new ContainerBuilder();
              let content = `## **${role.nickname}** - ${tr("mission_Notify_Title")}\n`;
              content += `### ${tr("monitor_Notify_Mission_Now")} \`${cur}/${max}\`\n`;
              content += `### ${tr("monitor_Notify_Mission_Reset_Prefix")}<t:${resetTime.unix()}:R>${tr("monitor_Notify_Mission_Reset_Suffix")}`;

              container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(content),
              );

              await this.sendNotification(userId, config, {
                flags: MessageFlags.IsComponentsV2,
                components: [container],
              });
              await this.client.db.set(
                `${userId}.lastMissionNotify.${role.roleId}_${resetTime.format("YYYY-MM-DD")}`,
                nowTs,
              );
            }
          }
        }
      }
    } catch (e) {
      this.logger.error(`Monitor error for ${userId}: ${e}`);
    }
  }

  private async sendNotification(
    userId: string,
    config: MonitorConfig,
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
      this.logger.error("Failed to broadcast monitor notification: " + e);
    }
  }
}
