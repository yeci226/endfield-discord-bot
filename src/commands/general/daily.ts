import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalSubmitInteraction,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { ensureAccountBinding, getAccounts } from "../../utils/accountUtils";
import {
  getGamePlayerBinding,
  getAttendanceList,
  executeAttendance,
  formatSkGameRole,
  verifyToken,
} from "../../utils/skportApi";
import { CustomDatabase } from "../../utils/Database";
import { extractAccountToken } from "../account/login";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Endfield Daily Attendance")
    .setNameLocalizations({
      "zh-TW": "每日簽到",
    })
    .setDescriptionLocalizations({
      "zh-TW": "終末地每日簽到與自動簽到設定",
    })
    .addSubcommand((sub) =>
      sub
        .setName("check")
        .setDescription("Check attendance status")
        .setNameLocalizations({ "zh-TW": "檢查狀態" })
        .setDescriptionLocalizations({
          "zh-TW": "檢查簽到記錄",
        }),
    )
    .addSubcommand((sub) =>
      sub
        .setName("claim")
        .setDescription("Claim daily rewards manually")
        .setNameLocalizations({ "zh-TW": "立即簽到" })
        .setDescriptionLocalizations({
          "zh-TW": "手動獲取簽到獎勵",
        }),
    )
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Configure auto-sign settings")
        .setNameLocalizations({ "zh-TW": "自動簽到設定" })
        .setDescriptionLocalizations({
          "zh-TW": "設定自動簽到",
        })
        .addIntegerOption((op) =>
          op
            .setName("time")
            .setDescription("Schedule time (1-24 UTC+8)")
            .setNameLocalizations({ "zh-TW": "簽到時間" })
            .setDescriptionLocalizations({
              "zh-TW": "簽到時間 1-24 UTC+8",
            })
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(24),
        )
        .addBooleanOption((op) =>
          op
            .setName("auto_balance")
            .setDescription("Automatically choose the best time")
            .setNameLocalizations({ "zh-TW": "自動選擇時間" })
            .setDescriptionLocalizations({
              "zh-TW": "自動選擇現有設定人數較少的時間簽到",
            })
            .setRequired(false),
        )
        .addBooleanOption((op) =>
          op
            .setName("notify")
            .setDescription("Notify when signed in")
            .setNameLocalizations({ "zh-TW": "通知" })
            .setDescriptionLocalizations({
              "zh-TW": "是否在簽到時通知",
            })
            .setRequired(false),
        )
        .addStringOption((op) =>
          op
            .setName("notify_method")
            .setDescription("Notification method (default: DM)")
            .setNameLocalizations({ "zh-TW": "通知方式" })
            .setDescriptionLocalizations({
              "zh-TW": "通知發送方式 (預設: 私訊)",
            })
            .addChoices(
              { name: "私訊", value: "dm" },
              { name: "當前頻道", value: "channel" },
            )
            .setRequired(false),
        ),
    ) as SlashCommandBuilder,

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    // We can assume tr is passed or default to a simple function if not
    const t = tr || ((key: string) => key);

    if (!interaction.isChatInputCommand()) return;

    if (interaction.options.getSubcommand() === "setup") {
      await handleSetup(client, interaction, db);
      return;
    }

    await interaction.deferReply({ flags: (1 << 15) | MessageFlags.Ephemeral });

    const userId = interaction.user.id;
    const accounts = await getAccounts(db, userId);

    if (!accounts || accounts.length === 0) {
      const container = new ContainerBuilder();
      const textDisplay = new TextDisplayBuilder().setContent(
        t("NoSetAccount"),
      );
      container.addTextDisplayComponents(textDisplay);

      await interaction.editReply({
        content: "",
        flags: MessageFlags.IsComponentsV2,
        components: [container],
      });
      return;
    }

    const isClaim = interaction.options.getSubcommand() === "claim";
    const container = new ContainerBuilder();
    let hasResult = false;

    // Summary Section
    const summaryText = new TextDisplayBuilder().setContent(
      isClaim ? t("daily_Checking") : t("daily_Status"),
    );
    container.addTextDisplayComponents(summaryText);

    const processedRoles = new Set<string>();

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      // AUTO-MIGRATION & REBIND LOGIC - ensures account.roles is updated if possible
      await ensureAccountBinding(account, userId, db, t.lang);

      // Use potentially updated roles
      const roles = account.roles;
      if (!roles || roles.length === 0) continue;

      for (const binding of roles) {
        for (const role of binding.roles) {
          const gameRoleStr = formatSkGameRole(
            binding.gameId || 1, // Fallback to 1 (Endfield)
            role.roleId,
            role.serverId,
          );

          if (processedRoles.has(gameRoleStr)) continue;
          processedRoles.add(gameRoleStr);

          hasResult = true;

          let status = await getAttendanceList(
            gameRoleStr,
            account.cookie,
            t.lang,
            account.cred,
            account.salt,
          );
          let claimResult = null;
          let claimedNow = false;

          if (isClaim && status && !status.hasToday) {
            claimResult = await executeAttendance(
              gameRoleStr,
              account.cookie,
              t.lang,
              account.cred,
              account.salt,
            );
            if (claimResult && claimResult.code === 0) {
              claimedNow = true;
              // Refresh status
              status = await getAttendanceList(
                gameRoleStr,
                account.cookie,
                t.lang,
                account.cred,
                account.salt,
              );
            }
          }

          // Build Section for this role
          const totalDays = status?.calendar.filter((d) => d.done).length || 0;
          const todayReward =
            status?.calendar.find((r) => r.available) ||
            [...(status?.calendar || [])].reverse().find((r) => r.done);

          let rewardName = t("None");
          let rewardIcon = "";

          if (todayReward) {
            const resInfo = status?.resourceInfoMap?.[todayReward.awardId];
            if (resInfo) {
              rewardName = `${resInfo.name} x${resInfo.count}`;
              rewardIcon = resInfo.icon;
            }
          }

          let firstRewardName = "";
          let firstRewardIcon = "";

          if (status?.first) {
            const signedCount = status.calendar.filter((d) => d.done).length;

            // Try to find an available first reward (e.g., for day 1, 2, or 3)
            let targetFirst = status.first.find((f) => f.available);

            // If nothing is explicitly available now (maybe because we just signed in),
            // we should NOT fallback to signedCount because signedCount is MONTHLY,
            // while "first" rewards are ONE-TIME (lifetime). using signedCount causes
            // "Newcomer Reward" to appear on day 1-3 of EVERY month, which is wrong.
            // We rely solely on `available` field from API or if we want to confirm claiming,
            // we'd need better data. For now, strict check is better than wrong info.

            if (targetFirst && (targetFirst.available || targetFirst.done)) {
              const fRes = status.resourceInfoMap[targetFirst.awardId];
              if (fRes) {
                firstRewardName = `${fRes.name} x${fRes.count}`;
                if (!rewardIcon) firstRewardIcon = fRes.icon;
              }
            }
          }

          let statusText = "";
          if (status?.hasToday || claimedNow) {
            statusText = `## ${t("daily_Success")}\n### ${t("daily_TodayReward")}: \`${rewardName}\``;
            if (firstRewardName) {
              statusText += `\n### ${t("daily_FirstReward")}: \`${firstRewardName}\``;
            }
            statusText += `\n### ${t("daily_TotalDays")}: \`${totalDays}\` ${t("Day")}`;
          } else {
            statusText = `## ${t("daily_Failed")}\n### ${t("daily_TodayPending")}: \`${rewardName}\``;
            if (firstRewardName) {
              statusText += `\n### ${t("daily_FirstReward")}: \`${firstRewardName}\``;
            }
            statusText += `\n### ${t("daily_TotalDays")}: \`${totalDays}\` ${t("Day")}`;
            if (isClaim && !claimedNow) {
              statusText += `\n⚠️ ${t("Error")}: \`${claimResult?.message || t("UnknownError")}\``;
            }
          }

          const textDisplay = new TextDisplayBuilder().setContent(
            `**${role.nickname}** (Lv.${role.level}) - ${role.serverName}\n${statusText}`,
          );
          if (rewardIcon) {
            const roleSection = new SectionBuilder()
              .addTextDisplayComponents(textDisplay)
              .setThumbnailAccessory(
                new ThumbnailBuilder({ media: { url: rewardIcon } }),
              );
            container.addSectionComponents(roleSection);
          } else {
            container.addTextDisplayComponents(textDisplay);
          }
        }
      }
    }

    if (!hasResult) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(t("daily_RoleNotFound")),
      );
    }

    await interaction.editReply({
      content: "",
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [container],
    });
  },
};

async function handleSetup(
  client: ExtendedClient,
  interaction: ChatInputCommandInteraction,
  db: CustomDatabase,
) {
  const userId = interaction.user.id;
  const time = interaction.options.getInteger("time");
  const autoBalance = interaction.options.getBoolean("auto_balance");
  const notify = interaction.options.getBoolean("notify");
  const notifyMethod = interaction.options.getString("notify_method");

  // Load existing or default
  const dailyData = ((await db.get("autoDaily")) as Record<string, any>) || {};
  const userConfig = dailyData[userId] || {
    time: 13,
    auto_balance: false,
    notify: true,
    notify_method: "dm",
    channelId: interaction.channelId,
  };

  if (autoBalance) {
    userConfig.auto_balance = true;
    // Calculate best time
    userConfig.time = await client.autoDailyService.getBalancedHour();
  } else if (time !== null) {
    userConfig.auto_balance = false;
    userConfig.time = time; // 1-24 input
    if (userConfig.time === 24) userConfig.time = 0;
  }

  if (notify !== null) {
    userConfig.notify = notify;
  }

  if (notifyMethod !== null) {
    userConfig.notify_method = notifyMethod as "dm" | "channel";
  }

  // Always update channelId to current where command is run
  userConfig.channelId = interaction.channelId;

  dailyData[userId] = userConfig;
  await db.set("autoDaily", dailyData);

  const { createTranslator, toI18nLang } = require("../../utils/i18n");
  const userLang =
    (await db.get(`${interaction.user.id}.locale`)) ||
    toI18nLang(interaction.locale);
  const t = createTranslator(userLang);

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${t("daily_SetupSuccess")}\n` +
        `**${t("daily_SetupTime")}**: \`${userConfig.time}:00\` (UTC+8)\n` +
        `**${t("daily_SetupNotify")}**: \`${userConfig.notify ? t("True") : t("False")}\`\n` +
        `**${t("daily_SetupNotifyMethod")}**: \`${userConfig.notify_method === "dm" ? t("daily_DM") : t("daily_Channel")}\`\n` +
        `**${t("daily_SetupChannel")}**: <#${userConfig.channelId}>`,
    ),
  );

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
  });
}

export default command;
