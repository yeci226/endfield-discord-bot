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
import {
  getGamePlayerBinding,
  getAttendanceList,
  executeAttendance,
  formatSkGameRole,
} from "../../utils/skportApi";
import { CustomDatabase } from "../../utils/Database";

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
            .setDescription("Schedule time (1-24 UTC-8)")
            .setNameLocalizations({ "zh-TW": "簽到時間" })
            .setDescriptionLocalizations({
              "zh-TW": "簽到時間 1-24 UTC-8",
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
    const accounts = (await db.get(`${userId}.accounts`)) as any[];

    if (!accounts || accounts.length === 0) {
      const container = new ContainerBuilder();
      const textDisplay = new TextDisplayBuilder().setContent(
        "❌ **未找到綁定帳號**\n請先使用 `/set-cookie` 綁定您的終末地帳號。",
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
      isClaim ? "🔄 **正在執行每日簽到...**" : "📅 **每日簽到狀態**",
    );
    container.addTextDisplayComponents(summaryText);

    const processedRoles = new Set<string>();

    for (const account of accounts) {
      const bindings = await getGamePlayerBinding(
        account.cookie,
        interaction.locale,
        account.cred,
      );

      if (!bindings) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `⚠️ **取得綁定失敗**: ${account.info.nickname}`,
          ),
        );
        continue;
      }

      const endfieldApp = bindings.find((b) => b.appCode === "endfield");
      if (!endfieldApp) continue;

      for (const binding of endfieldApp.bindingList) {
        for (const role of binding.roles) {
          const gameRoleStr = formatSkGameRole(
            binding.gameId,
            role.roleId,
            role.serverId,
          );

          if (processedRoles.has(gameRoleStr)) continue;
          processedRoles.add(gameRoleStr);

          hasResult = true;

          let status = await getAttendanceList(
            gameRoleStr,
            account.cookie,
            interaction.locale,
            account.cred,
          );
          let claimResult = null;
          let claimedNow = false;

          if (isClaim && status && !status.hasToday) {
            claimResult = await executeAttendance(
              gameRoleStr,
              account.cookie,
              interaction.locale,
              account.cred,
            );
            if (claimResult && claimResult.code === 0) {
              claimedNow = true;
              // Refresh status
              status = await getAttendanceList(
                gameRoleStr,
                account.cookie,
                interaction.locale,
                account.cred,
              );
            }
          }

          // Build Section for this role
          const totalDays = status?.calendar.filter((d) => d.done).length || 0;
          const todayReward =
            status?.calendar.find((r) => r.available) ||
            status?.calendar.find((r) => r.done);

          let rewardName = "未知獎勵";
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
            // and we have signed today, then the "first" reward for this level corresponds to our current count.
            if (!targetFirst && (status.hasToday || claimedNow)) {
              if (signedCount >= 1 && signedCount <= 3) {
                targetFirst = status.first[signedCount - 1];
              }
            }

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
            statusText = `## ✅ **已簽到**\n### 今日獎勵: \`${rewardName}\``;
            if (firstRewardName) {
              statusText += `\n### 新人獎勵: \`${firstRewardName}\``;
            }
            statusText += `\n### 累計簽到: \`${totalDays}\` 天`;
          } else {
            statusText = `## ❌ **未簽到**\n### 今日待領: \`${rewardName}\``;
            if (firstRewardName) {
              statusText += `\n### 新人獎勵: \`${firstRewardName}\``;
            }
            statusText += `\n### 累計簽到: \`${totalDays}\` 天`;
            if (isClaim && !claimedNow) {
              statusText += `\n⚠️ 簽到失敗: \`${claimResult?.message || "未知錯誤"}\``;
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
        new TextDisplayBuilder().setContent("⚠️ **未找到任何 Endfield 角色**"),
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

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `✅ **自動簽到設定已更新**\n` +
        `簽到時間: \`${userConfig.time}:00\` (Asia/Taipei)\n` +
        `通知開關: \`${userConfig.notify ? "開啟" : "關閉"}\`\n` +
        `通知方式: \`${userConfig.notify_method === "dm" ? "私訊" : "頻道"}\`\n` +
        `頻道: <#${userConfig.channelId}>`,
    ),
  );

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
  });
}

export default command;
