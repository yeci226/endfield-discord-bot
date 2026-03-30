import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
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
import { buildDailyAttendanceCard } from "../../utils/dailyCanvasUtils";

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
        )
        .addBooleanOption((op) =>
          op
            .setName("mention")
            .setDescription("Mention user when signing in")
            .setNameLocalizations({ "zh-TW": "提及模式" })
            .setDescriptionLocalizations({
              "zh-TW": "是否在簽到完成後提及您",
            })
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
      await interaction.editReply({
        content: t("NoSetAccount"),
      });
      return;
    }

    const isClaim = interaction.options.getSubcommand() === "claim";
    let hasResult = false;
    const outputLines: string[] = [];
    const files: AttachmentBuilder[] = [];

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

          if (files.length < 10) {
            const buffer = await buildDailyAttendanceCard({
              roleName: `${role.nickname}`,
              roleMeta: `Lv.${role.level} - ${role.serverName}`,
              totalDays: Number(res.totalDays || 0),
              calendarTotalDays: Number(res.calendarTotalDays || 0),
              todayClaimedNow: !!res.signedNow,
              yesterdayReward: {
                name: res.yesterdayReward?.name || t("None") || "None",
                icon: res.yesterdayReward?.icon || "",
                done: !!res.yesterdayReward?.done,
              },
              todayReward: {
                name:
                  res.todayReward?.name ||
                  res.rewardName ||
                  t("None") ||
                  "None",
                icon: res.todayReward?.icon || res.rewardIcon || "",
                done: !!res.todayReward?.done,
              },
              nextRewards: Array.isArray(res.nextRewards)
                ? res.nextRewards
                : [],
              tr,
            });

            files.push(
              new AttachmentBuilder(buffer, {
                name: `daily-${role.roleId}-${role.serverId}.png`,
              }),
            );
          }
        }
      }
    }

    if (!hasResult) {
      await interaction.editReply({
        content: t("daily_RoleNotFound"),
      });
      return;
    }

    if (files.length === 10) {
      outputLines.push("- 已達附件上限 10 張，其餘角色請分批查詢。");
    }

    await interaction.editReply({
      content: outputLines.join("\n"),
      files,
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
  const notify = interaction.options.getBoolean("notify");
  const notifyMethod = interaction.options.getString("notify_method");
  const selectedChannelId = interaction.options.getString("channel");
  const mention = interaction.options.getBoolean("mention");

  // Load existing or default - Using granular keys
  const userConfig = (await db.get(`autoDaily.${userId}`)) || {
    time: 13,
    notify: true,
    notify_method: "dm",
    channelId: interaction.channelId,
    mention: true,
  };

  userConfig.time = normalizeDailyHour(userConfig.time, 13);

  if (time !== null) {
    userConfig.time = time; // 1-24 input
    if (userConfig.time === 24) userConfig.time = 0;
  } else {
    // If user doesn't specify time, auto-assign the least crowded hour.
    userConfig.time = await client.autoDailyService.getBalancedHour();
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

  if (mention !== null) {
    userConfig.mention = mention;
  } else if (userConfig.mention === undefined) {
    userConfig.mention = true;
  }

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
    `**${t("daily_SetupMention")}**: \`${userConfig.mention ? t("True") : t("False")}\`\n` +
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
