import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  ModalSubmitInteraction,
  ChannelType,
  PermissionsBitField,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import {
  ensureAccountBinding,
  getAccounts,
  withAutoRefresh,
} from "../../utils/accountUtils";
import { formatSkGameRole } from "../../utils/skportApi";
import { CustomDatabase } from "../../utils/Database";
import { processRoleAttendance } from "../../utils/attendanceUtils";

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
            .addChoices(
              ...Array.from({ length: 24 }, (_, i) => {
                const hour = i + 1;
                return {
                  name: `${hour}`,
                  value: hour,
                };
              }),
            )
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
        )
        .addStringOption((op) =>
          op
            .setName("channel")
            .setDescription(
              "Target channel when notification method is channel",
            )
            .setNameLocalizations({ "zh-TW": "通知頻道" })
            .setDescriptionLocalizations({
              "zh-TW": "通知方式為頻道時，選擇要發送通知的頻道",
            })
            .setAutocomplete(true)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("View real-time status of all bound accounts")
        .setNameLocalizations({ "zh-TW": "狀態總覽" })
        .setDescriptionLocalizations({
          "zh-TW": "查看所有綁定帳號的理智、任務與簽到狀態",
        }),
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

    if (interaction.options.getSubcommand() === "status") {
      await handleStatus(client, interaction, db, t);
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
            binding.gameId || 3, // Fallback to 3 (Endfield)
            role.roleId,
            role.serverId,
          );

          if (processedRoles.has(gameRoleStr)) continue;
          processedRoles.add(gameRoleStr);

          hasResult = true;

          let res: any;
          try {
            res = await withAutoRefresh(
              client,
              userId,
              account,
              (c: string, s: string, options: any) =>
                processRoleAttendance(
                  role,
                  binding.gameId || 3,
                  account.cookie,
                  t.lang,
                  c,
                  s,
                  isClaim,
                  t,
                  options,
                ),
              t.lang,
            );
          } catch (e: any) {
            if (e.message === "TokenExpired") {
              res = {
                error: true,
                message: t("TokenExpired"),
              };
            } else {
              throw e;
            }
          }

          if (!res) continue;

          let statusText = "";
          if (res.hasToday || res.signedNow) {
            statusText = `## ${t("daily_Success")}\n### ${t("daily_TodayReward")}: \`${res.rewardName}\``;
            if (res.firstRewardName) {
              statusText += `\n### ${t("daily_FirstReward")}: \`${res.firstRewardName}\``;
            }
            statusText += `\n### ${t("daily_TotalDays")}: \`${res.totalDays}\` ${t("Day")}`;
          } else {
            statusText = `## ${t("daily_Failed")}\n### ${t("daily_TodayPending")}: \`${res.rewardName}\``;
            if (res.firstRewardName) {
              statusText += `\n### ${t("daily_FirstReward")}: \`${res.firstRewardName}\``;
            }
            statusText += `\n### ${t("daily_TotalDays")}: \`${res.totalDays}\` ${t("Day")}`;
            if (isClaim && !res.signedNow) {
              statusText += `\n⚠️ ${t("Error")}: \`${res.message || t("UnknownError")}\``;
            }
          }

          const textDisplay = new TextDisplayBuilder().setContent(
            `**${role.nickname}** (Lv.${role.level}) - ${role.serverName}\n${statusText}`,
          );
          if (res.rewardIcon) {
            const roleSection = new SectionBuilder()
              .addTextDisplayComponents(textDisplay)
              .setThumbnailAccessory(
                new ThumbnailBuilder({ media: { url: res.rewardIcon } }),
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
  const selectedChannelId = interaction.options.getString("channel");

  // Load existing or default - Using granular keys
  const userConfig = (await db.get(`autoDaily.${userId}`)) || {
    time: 13,
    auto_balance: false,
    notify: true,
    notify_method: "dm",
    channelId: interaction.channelId,
  };

  userConfig.time = normalizeDailyHour(userConfig.time, 13);

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

  const staminaNotify = interaction.options.getBoolean("stamina_notify");
  const missionNotify = interaction.options.getBoolean("mission_notify");
  const staminaThreshold = interaction.options.getInteger("stamina_threshold");

  if (staminaNotify !== null) userConfig.stamina_notify = staminaNotify;
  if (missionNotify !== null) userConfig.mission_notify = missionNotify;
  if (staminaThreshold !== null)
    userConfig.stamina_threshold = staminaThreshold;

  if (selectedChannelId && interaction.guild) {
    const channel = interaction.guild.channels.cache.get(selectedChannelId);
    const member = interaction.member;
    const botMember = interaction.guild.members.me;

    const userCanSend =
      !!channel &&
      !!member &&
      channel
        .permissionsFor(member as any)
        ?.has(PermissionsBitField.Flags.SendMessages);

    if (!userCanSend) {
      await interaction.reply({
        content:
          interaction.locale === "zh-TW"
            ? "您沒有在該頻道發送訊息的權限，請改選其他頻道。"
            : "You cannot send messages in the selected channel. Please choose another channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const botCanSend =
      !!channel &&
      !!botMember &&
      channel
        .permissionsFor(botMember)
        ?.has(PermissionsBitField.Flags.SendMessages);

    userConfig.channelId = selectedChannelId;
    userConfig.channelBotCanSend = !!botCanSend;
  } else if (!userConfig.channelId) {
    userConfig.channelId = interaction.channelId;
  }

  await db.set(`autoDaily.${userId}`, userConfig);

  const { createTranslator, toI18nLang } = require("../../utils/i18n");
  const userLang =
    (await db.get(`${interaction.user.id}.locale`)) ||
    toI18nLang(interaction.locale);
  const t = createTranslator(userLang);

  let setupContent =
    `### ${t("daily_SetupSuccess")}\n` +
    `**${t("daily_SetupTime")}**: \`${userConfig.time}:00\` (UTC+8)\n` +
    `**${t("daily_SetupNotify")}**: \`${userConfig.notify ? t("True") : t("False")}\`\n` +
    `**${t("daily_SetupNotifyMethod")}**: \`${userConfig.notify_method === "dm" ? t("daily_DM") : t("daily_Channel")}\` `;

  if (userConfig.notify_method !== "dm") {
    setupContent += `\n**${t("daily_SetupChannel")}**: <#${userConfig.channelId}>`;
  }

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(setupContent),
  );

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
  });
}

function normalizeDailyHour(value: unknown, fallback: number): number {
  const toHour = (raw: unknown): number | null => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const x = Math.floor(n);
    if (x === 24) return 0;
    if (x >= 0 && x <= 23) return x;
    if (x >= 1 && x <= 24) return x % 24;
    return null;
  };

  if (Array.isArray(value)) {
    for (const it of value) {
      const h = toHour(it);
      if (h !== null) return h;
    }
    return fallback;
  }

  if (typeof value === "string") {
    const tokens = value
      .split(/[\s,，、;；|/]+/)
      .map((x) => x.trim())
      .filter(Boolean);

    for (const t of tokens) {
      const h = toHour(t);
      if (h !== null) return h;
    }

    return fallback;
  }

  const one = toHour(value);
  return one === null ? fallback : one;
}

async function handleStatus(
  client: ExtendedClient,
  interaction: ChatInputCommandInteraction,
  db: CustomDatabase,
  tr: any,
) {
  const t = tr || ((key: string) => key);
  await interaction.deferReply({ flags: (1 << 15) | MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const accounts = await getAccounts(db, userId);

  if (!accounts || accounts.length === 0) {
    await interaction.editReply(t("NoSetAccount"));
    return;
  }

  const { getCardDetail, getAttendanceList } = require("../../utils/skportApi");
  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(t("daily_StatusSummary")),
  );

  const processedRoles = new Set<string>();
  const rows = [];

  for (const account of accounts) {
    if (account.invalid) continue;
    await ensureAccountBinding(account, userId, db, t.lang);

    const roles = account.roles;
    if (!roles || roles.length === 0) continue;

    for (const binding of roles) {
      for (const role of binding.roles) {
        const gameRoleStr = `3_${role.roleId}_${role.serverId}`;
        if (processedRoles.has(gameRoleStr)) continue;
        processedRoles.add(gameRoleStr);

        try {
          const [cardRes, attendRes] = (await Promise.all([
            withAutoRefresh(client, userId, account, (c, s, options) =>
              getCardDetail(
                role.roleId,
                role.serverId,
                account.info?.id || role.roleId,
                t.lang,
                c,
                s,
                options,
              ),
            ),
            withAutoRefresh(client, userId, account, (c, s, options) =>
              getAttendanceList(
                gameRoleStr,
                account.cookie,
                t.lang,
                c,
                s,
                options,
              ),
            ),
          ])) as any[];

          if (cardRes?.code === 0 && cardRes.data?.detail) {
            const d = cardRes.data.detail;
            const stamina = `${d.dungeon.curStamina}/${d.dungeon.maxStamina}`;
            const mission = `${d.dailyMission.dailyActivation}/${d.dailyMission.maxDailyActivation}`;
            const bp = `Lv.${d.bpSystem.curLevel}`;
            const checkin = attendRes?.data?.hasToday ? "✅" : "❌";

            rows.push(
              `**${role.nickname}**\n` +
                `> 🔋 ${t("daily_Status_Stamina")}: \`${stamina}\` | 🎯 ${t("daily_Status_Missions")}: \`${mission}\`\n` +
                `> 🎫 ${t("daily_Status_BP")}: \`${bp}\` | 🗓️ ${t("daily_Status_Checkin")}: ${checkin}`,
            );
          }
        } catch (e) {
          rows.push(`**${role.nickname}**: ⚠️ ${t("Error")}`);
        }
      }
    }
  }

  if (rows.length === 0) {
    await interaction.editReply(t("daily_RoleNotFound"));
    return;
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(rows.join("\n\n")),
  );

  await interaction.editReply({
    content: "",
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
  });
}

export default command;

command.autocomplete = async (client, interaction, db) => {
  const subcommand = interaction.options.getSubcommand(false);
  const focused = interaction.options.getFocused(true);

  if (subcommand !== "setup" || focused.name !== "channel") {
    await interaction.respond([]);
    return;
  }

  if (!interaction.guild) {
    await interaction.respond([]);
    return;
  }

  const me = interaction.guild.members.me;
  const member = interaction.member;
  const query = String(focused.value || "").toLowerCase();
  const isZh = interaction.locale === "zh-TW";

  const channels = interaction.guild.channels.cache
    .filter(
      (ch) =>
        ch.type === ChannelType.GuildText ||
        ch.type === ChannelType.GuildAnnouncement,
    )
    .map((ch) => {
      const userCanSend =
        !!member &&
        ch
          .permissionsFor(member as any)
          ?.has(PermissionsBitField.Flags.SendMessages);
      if (!userCanSend) return null;

      const botCanSend =
        !!me &&
        ch.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);

      const suffix = botCanSend
        ? ""
        : isZh
          ? "（機器人無發送訊息權限）"
          : " (Bot cannot send messages)";

      return {
        name: `${ch.name}${suffix}`.slice(0, 100),
        value: ch.id,
        rawName: ch.name.toLowerCase(),
      };
    })
    .filter((x): x is { name: string; value: string; rawName: string } => !!x)
    .filter(
      (x) => x.rawName.includes(query) || x.value.toLowerCase().includes(query),
    )
    .slice(0, 25)
    .map(({ name, value }) => ({ name, value }));

  await interaction.respond(channels);
};
