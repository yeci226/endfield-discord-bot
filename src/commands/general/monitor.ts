import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  ModalSubmitInteraction,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { getAccounts, withAutoRefresh } from "../../utils/accountUtils";
import { CustomDatabase } from "../../utils/Database";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("monitor")
    .setDescription("Configure stamina and mission reminders")
    .setNameLocalizations({
      "zh-TW": "監控提醒",
    })
    .setDescriptionLocalizations({
      "zh-TW": "設定理智與任務監控提醒",
    })
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Configure monitoring settings")
        .setNameLocalizations({ "zh-TW": "設定" })
        .setDescriptionLocalizations({
          "zh-TW": "設定監控項目的相關參數與通知方式",
        })
        .addBooleanOption((op) =>
          op
            .setName("stamina_notify")
            .setDescription("Notify when stamina is nearly full")
            .setNameLocalizations({ "zh-TW": "理智提醒" })
            .setDescriptionLocalizations({ "zh-TW": "當理智快滿時發送通知" })
            .setRequired(false),
        )
        .addIntegerOption((op) =>
          op
            .setName("stamina_offset")
            .setDescription("Notify at this distance to full (default 10)")
            .setNameLocalizations({ "zh-TW": "理智通知偏移" })
            .setDescriptionLocalizations({
              "zh-TW": "設定距離理智滿值多少時通知（預設 10）",
            })
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(240),
        )
        .addBooleanOption((op) =>
          op
            .setName("mission_notify")
            .setDescription("Remind pending daily missions before reset")
            .setNameLocalizations({ "zh-TW": "任務提醒" })
            .setDescriptionLocalizations({
              "zh-TW": "伺服器重置前提醒尚未完成的每日任務",
            })
            .setRequired(false),
        )
        .addStringOption((op) =>
          op
            .setName("notify_method")
            .setDescription("Notification method (default: DM)")
            .setNameLocalizations({ "zh-TW": "通知方式" })
            .setDescriptionLocalizations({
              "zh-TW": "設定通知的發送方式（預設：私訊）",
            })
            .addChoices(
              { name: "私訊", value: "dm" },
              { name: "當前頻道", value: "channel" },
            )
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Disable and remove monitoring settings")
        .setNameLocalizations({ "zh-TW": "移除" })
        .setDescriptionLocalizations({
          "zh-TW": "停用並移除理智與任務監控提醒設定",
        }),
    ) as SlashCommandBuilder,

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    const t = tr || ((key: string) => key);

    if (!interaction.isChatInputCommand()) return;

    if (interaction.options.getSubcommand() === "setup") {
      await handleSetup(client, interaction, db, t);
      return;
    }

    if (interaction.options.getSubcommand() === "remove") {
      await handleRemove(client, interaction, db, t);
      return;
    }
  },
};

async function handleSetup(
  client: ExtendedClient,
  interaction: ChatInputCommandInteraction,
  db: CustomDatabase,
  t: any,
) {
  const userId = interaction.user.id;
  const staminaNotify = interaction.options.getBoolean("stamina_notify");
  const staminaOffset = interaction.options.getInteger("stamina_offset");
  const missionNotify = interaction.options.getBoolean("mission_notify");
  const notifyMethod = interaction.options.getString("notify_method");

  const monitorData =
    ((await db.get("monitorConfig")) as Record<string, any>) || {};
  const userConfig = monitorData[userId] || {
    stamina_notify: true,
    stamina_offset: 10,
    mission_notify: true,
    notify_method: "dm",
    channelId: interaction.channelId,
  };

  if (staminaNotify !== null) userConfig.stamina_notify = staminaNotify;
  if (staminaOffset !== null) userConfig.stamina_offset = staminaOffset;
  if (missionNotify !== null) userConfig.mission_notify = missionNotify;
  if (notifyMethod !== null) userConfig.notify_method = notifyMethod;

  userConfig.channelId = interaction.channelId;
  monitorData[userId] = userConfig;
  await db.set("monitorConfig", monitorData);

  const staminaValue = userConfig.stamina_notify
    ? `240 - ${userConfig.stamina_offset} = ${240 - userConfig.stamina_offset}`
    : t("monitor_SetupNoStamina");

  const setupContent =
    `## ${t("monitor_SetupSuccess")}\n` +
    `### ${t("monitor_SetupStamina")} \`${staminaValue}\`\n` +
    `### ${t("monitor_SetupMission")} \`${userConfig.mission_notify ? t("True") : t("False")}\`\n` +
    `### ${t("monitor_SetupNotifyMethod")}: ${userConfig.notify_method === "dm" ? t("daily_DM") : t("daily_Channel")}` +
    (userConfig.notify_method !== "dm"
      ? `\n### ${t("monitor_SetupChannel")}: <#${userConfig.channelId}>`
      : "");

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(setupContent),
  );

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
  });
}

async function handleRemove(
  client: ExtendedClient,
  interaction: ChatInputCommandInteraction,
  db: CustomDatabase,
  t: any,
) {
  const userId = interaction.user.id;
  const monitorData =
    ((await db.get("monitorConfig")) as Record<string, any>) || {};

  if (!monitorData[userId]) {
    await interaction.reply({
      content: t("Error"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  delete monitorData[userId];
  await db.set("monitorConfig", monitorData);

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`# ${t("monitor_RemoveSuccess")}`),
  );

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
  });
}

export default command;
