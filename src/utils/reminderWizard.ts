import { accountId } from "./accountData";
import { ProfileTemplateService } from "../services/ProfileTemplateService";
import { randomBytes, randomUUID } from "crypto";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { ExtendedClient } from "../structures/Client";
import { getAccounts, withAutoRefresh } from "./accountUtils";
import { getCardDetail, CardDetail } from "./skportApi";
import { findProfileAccount } from "./profileView";
import {
  defaultReminder,
  evaluateReminder,
  reminderKey,
  ReminderConfig,
  reminderSections,
  ReminderState,
  reminderStateKey,
  reminderTargets,
  resolveLegacyThreshold,
  validateReminder,
} from "./reminders";
import { drawPlayerCard, playerText } from "./playerCards";
import {
  deleteReminderWizardSession,
  getReminderWizardSession,
  pruneExpiredReminderWizardSessions,
  saveReminderWizardSession,
} from "./reminderWizardSessions";
import type { ReminderWizardSessionRecord } from "./reminderWizardSessions";

interface Session extends ReminderWizardSessionRecord {
  lang: string;
  targets: ReturnType<typeof reminderTargets>;
  page: string;
  uid?: string;
  config?: ReminderConfig;
  detail?: CardDetail;
  legacy?: any;
  imported?: boolean;
  accountPage: number;
}
const activeSessions = new Set<string>();
const row = (...components: any[]) =>
  new ActionRowBuilder<any>().addComponents(...components);
const button = (id: string, label: string, primary = false) =>
  new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(primary ? ButtonStyle.Primary : ButtonStyle.Secondary);
const textInput = (id: string, title: string, value: number) =>
  new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId("value")
          .setLabel(title)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(value))
          .setMaxLength(4),
      ),
    );

async function loadDetail(
  client: ExtendedClient,
  s: Session,
  target: { uid: string; roleId: string; serverId: string },
): Promise<CardDetail> {
  const account = findProfileAccount(await getAccounts(client.db, s.owner), {
    ...target,
    ownerId: s.owner,
  });
  if (!account || account.invalid)
    throw new Error(
      playerText(
        s.lang,
        "帳號已失效，請重新登入。",
        "Account unavailable. Sign in again.",
      ),
    );
  const response = await withAutoRefresh(
    client,
    s.owner,
    account,
    (cred, salt, options) =>
      getCardDetail(
        target.roleId,
        target.serverId,
        target.uid,
        s.lang,
        cred,
        salt,
        options,
      ),
    s.lang,
  );
  if (response?.code !== 0 || !response.data?.detail)
    throw new Error(
      playerText(
        s.lang,
        "目前無法取得玩家資料，請稍後重試。",
        "Player data unavailable. Please retry.",
      ),
    );
  return response.data.detail;
}

async function checkChannel(
  client: ExtendedClient,
  interaction: any,
  channelId: string,
) {
  if (!interaction.guild)
    throw new Error("請在伺服器選擇頻道 / Select a channel inside a server");
  const channel: any = await interaction.guild.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.guildId !== interaction.guildId)
    throw new Error("無效頻道 / Invalid channel");
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const bot =
    interaction.guild.members.me || (await interaction.guild.members.fetchMe());
  const send = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  if (
    !channel
      .permissionsFor(member)
      ?.has([PermissionFlagsBits.ViewChannel, send]) ||
    !channel
      .permissionsFor(bot)
      ?.has([
        PermissionFlagsBits.ViewChannel,
        send,
        PermissionFlagsBits.AttachFiles,
      ])
  )
    throw new Error(
      "您與機器人需要檢視頻道、發送訊息權限，機器人還需要附加檔案權限 / Missing channel permissions",
    );
  return { channelId, guildId: interaction.guildId };
}

async function render(
  client: ExtendedClient,
  interaction: any,
  token: string,
  s: Session,
) {
  const t = (tw: string, en: string) => playerText(s.lang, tw, en),
    id = (action: string) => `reminder:${token}:${action}`;
  const c = s.config,
    container = new ContainerBuilder(),
    files: AttachmentBuilder[] = [];
  const heading = (title: string, body: string) =>
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title}\n${body}`),
    );
  const select = (
    action: string,
    placeholder: string,
    options: Array<{
      label: string;
      value: string;
      description?: string;
      default?: boolean;
    }>,
  ) =>
    row(
      new StringSelectMenuBuilder()
        .setCustomId(id(action))
        .setPlaceholder(placeholder)
        .addOptions(
          options.map((o) => ({
            ...o,
            label: o.label.slice(0, 100),
            description: o.description?.slice(0, 100),
          })),
        ),
    );
  if (s.page === "home") {
    const saved = await client.db.findByPrefix<ReminderConfig>(
      `reminder.v2.${s.owner}.`,
    );
    const status = await Promise.all(
      saved.map(async ({ value }) => {
        const state = await client.db.get<ReminderState>(
          reminderStateKey(value),
        );
        return `${value.name} · ${value.roleId} / ${value.serverId}: ${value.enabled ? (state?.revision === value.revision && state.disabledReason ? t("已暫停，請重新設定", "Paused; reconfigure") : t("已啟用", "Enabled")) : t("已關閉", "Off")}`;
      }),
    );
    heading(
      t("理智與每日任務提醒", "Sanity & daily reminders"),
      `${status.join("\n") || t("尚未啟用提醒", "No active reminders")}\n\n${t("每個帳號、角色分別設定。每 15 分鐘檢查，圖片含理智與每日任務。", "Configure each account and role separately. Checked every 15 minutes, with one status image.")}${s.legacy && !saved.length ? "\n" + t("已找到舊設定；選擇角色後可帶入草稿，儲存才會啟用。", "Legacy settings found. Imported as a draft; save to activate.") : ""}`,
    );
    const accounts = [...new Map(s.targets.map((r) => [r.uid, r])).values()];
    const shown = accounts.slice(s.accountPage * 25, (s.accountPage + 1) * 25);
    if (shown.length)
      container.addActionRowComponents(
        select(
          "account",
          t("選擇 SKPORT 帳號", "Select SKPORT account"),
          shown.map((a) => ({
            label: a.accountName,
            value: a.uid,
            description: a.uid,
          })),
        ),
      );
    else
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          t(
            "請先使用 /login 綁定終末地帳號。",
            "Use /login to link an Endfield account first.",
          ),
        ),
      );
    if (accounts.length > 25)
      container.addActionRowComponents(
        row(
          button(id("accountsPrev"), t("上一頁", "Previous")).setDisabled(
            s.accountPage === 0,
          ),
          button(id("accountsNext"), t("下一頁", "Next")).setDisabled(
            (s.accountPage + 1) * 25 >= accounts.length,
          ),
        ),
      );
  } else if (s.page === "role") {
    heading(
      t("選擇遊戲角色", "Select game role"),
      t(
        "提醒條件與通知目的地只套用至選取的角色。",
        "Rules and destination apply only to the selected role.",
      ),
    );
    container.addActionRowComponents(
      select(
        "role",
        t("選擇角色與伺服器", "Select role and server"),
        s.targets
          .filter((r) => r.uid === s.uid)
          .slice(0, 25)
          .map((r) => ({
            label: r.name,
            value: `${r.uid}|${r.serverId}|${r.roleId}`,
            description: `UID ${r.roleId} · Server ${r.serverId}`,
          })),
      ),
    );
  } else if (c) {
    const summary = `**${c.name}** · UID ${c.roleId} · Server ${c.serverId}\n${t("通知", "Destination")}: ${c.notify_method === "dm" ? t("私人訊息", "DM") : `<#${c.channelId || "0"}>`} · ${c.mention ? t("標註我", "Mention me") : t("不標註", "No mention")}\n${t("理智", "Sanity")}: ${c.sanity === "off" ? t("關閉", "Off") : c.sanity === "time" ? t(`回滿前 ${c.value} 分鐘內 (含已滿)`, `Within ${c.value} min of full (including full)`) : t(`達 ${c.value} (含已滿)`, `At least ${c.value} (including full)`)}\n${t("每日任務", "Daily activity")}: ${c.daily ? t(`未完成且重置前 ${c.dailyHours} 小時`, `Incomplete, within ${c.dailyHours} hours of reset`) : t("關閉", "Off")}\n${t("每日重置", "Daily reset")}: 04:00 ${c.resetOffset == null ? t("請選擇地區", "Select region") : `UTC${c.resetOffset >= 0 ? "+" : ""}${c.resetOffset}`}`;
    if (s.page === "destination") {
      heading(t("1 · 通知方式", "1 · Destination"), summary);
      container.addActionRowComponents(
        row(
          button(id("dm"), t("私人訊息", "DM")),
          button(id("current"), t("目前頻道", "Current channel")).setDisabled(
            !interaction.guildId,
          ),
          button(
            id("mention"),
            c.mention
              ? t("標註：開", "Mention: on")
              : t("標註：關", "Mention: off"),
          ),
        ),
      );
      if (interaction.guildId)
        container.addActionRowComponents(
          row(
            new ChannelSelectMenuBuilder()
              .setCustomId(id("channel"))
              .setPlaceholder(t("選擇其他頻道", "Choose another channel"))
              .setChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
              ),
          ),
        );
      container.addActionRowComponents(
        row(button(id("sanity"), t("下一步：理智", "Next: sanity"), true)),
      );
    } else if (s.page === "sanity") {
      heading(t("2 · 理智條件", "2 · Sanity condition"), summary);
      container.addActionRowComponents(
        select(
          "sanityPreset",
          t("選擇理智提醒條件", "Choose sanity condition"),
          [
            { label: t("關閉理智提醒", "Sanity reminders off"), value: "off" },
            ...[30, 60, 120, 240].map((n) => ({
              label: t(`回滿前 ${n} 分鐘`, `${n} minutes before full`),
              value: String(n),
            })),
          ],
        ),
      );
      container.addActionRowComponents(
        row(
          button(id("timeModal"), t("自訂時間", "Custom time")),
          button(
            id("amountModal"),
            t("自訂理智量", "Custom amount"),
          ).setDisabled(!(Number(s.detail?.dungeon?.maxStamina) > 0)),
          button(id("daily"), t("下一步：每日", "Next: daily"), true),
        ),
      );
    } else if (s.page === "daily") {
      heading(t("3 · 每日任務", "3 · Daily activity"), summary);
      container.addActionRowComponents(
        select(
          "dailyPreset",
          t("任務未完成時提醒", "Remind if activity is incomplete"),
          [
            { label: t("關閉每日提醒", "Daily reminders off"), value: "off" },
            ...[1, 3, 6, 12].map((n) => ({
              label: t(`重置前 ${n} 小時`, `${n} hours before reset`),
              value: String(n),
            })),
          ],
        ),
      );
      container.addActionRowComponents(
        row(
          button(id("dailyModal"), t("自訂時間", "Custom time")),
          button(id("asia"), "Asia · UTC+8"),
          button(id("west"), "America / Europe · UTC-5"),
        ),
      );
      container.addActionRowComponents(
        row(button(id("review"), t("檢查並儲存", "Review settings"), true)),
      );
    } else {
      heading(
        t("確認提醒設定", "Review reminders"),
        summary +
          "\n\n" +
          t(
            "理智達標後通知一次；降回門檻以下才重新啟用。每日每個重置週期最多一次。",
            "Sanity notifies once until it falls below the threshold. Daily activity notifies once per reset cycle.",
          ),
      );
      const result = evaluateReminder({ ...c, enabled: true }, {}, s.detail!);
      const image = await drawPlayerCard(
        s.detail!,
        t("提醒圖片預覽", "Reminder image preview"),
        reminderSections(c, s.detail!, result, s.lang),
        s.lang,
        Date.now(),
        await ProfileTemplateService.getUserTemplate(client.db, s.owner),
      );
      files.push(
        new AttachmentBuilder(image, { name: "reminder-preview.webp" }),
      );
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(
            "attachment://reminder-preview.webp",
          ),
        ),
      );
      container.addActionRowComponents(
        row(
          button(id("save"), t("儲存並啟用", "Save and enable"), true),
          button(id("disable"), t("關閉此角色提醒", "Disable this role")),
          button(id("destination"), t("返回修改", "Edit settings")),
        ),
      );
    }
  }
  if (s.page !== "home")
    container.addActionRowComponents(
      row(button(id("home"), t("返回帳號列表", "Back to accounts"))),
    );
  await interaction.editReply({
    content: null,
    attachments: [],
    files,
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  });
}

export async function reminderWizard(
  client: ExtendedClient,
  interaction: any,
  lang: string,
) {
  let token = interaction.customId?.split(":")[1],
    action = interaction.customId?.split(":")[2];
  let s: Session | undefined;
  if (interaction.isChatInputCommand()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await pruneExpiredReminderWizardSessions(client.db);
    token = randomBytes(8).toString("hex");
    s = {
      owner: interaction.user.id,
      expires: Date.now() + 15 * 60000,
      lang,
      targets: reminderTargets(
        await getAccounts(client.db, interaction.user.id),
      ),
      page: "home",
      accountPage: 0,
      legacy: (await client.db.get("monitorConfig"))?.[interaction.user.id],
    };
    await saveReminderWizardSession(client.db, token, s);
    await render(client, interaction, token, s);
    return;
  }

  const expiredMessage = playerText(
    lang,
    "設定已逾期或不屬於您，請重新使用 /reminder。",
    "Session expired or belongs to another user. Run /reminder again.",
  );
  if (!token) {
    await interaction.reply({
      content: expiredMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (activeSessions.has(token)) {
    await interaction.reply({
      content: playerText(
        lang,
        "正在處理，請稍候。",
        "Please wait for the current update.",
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  activeSessions.add(token);
  try {
    s = await getReminderWizardSession<Session>(client.db, token);
    if (!s || s.owner !== interaction.user.id) {
      await interaction.reply({
        content: expiredMessage,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    s.expires = Date.now() + 15 * 60000;
    const t = (tw: string, en: string) => playerText(s!.lang, tw, en);
    if (
      ["timeModal", "amountModal", "dailyModal"].includes(action) &&
      s.config
    ) {
      const value =
        action === "dailyModal"
          ? s.config.dailyHours
          : action === "amountModal"
            ? Math.min(Number(s.detail?.dungeon?.maxStamina), s.config.value)
            : s.config.value;
      const title =
        action === "dailyModal"
          ? t("重置前 1–12 小時", "1–12 hours before reset")
          : action === "timeModal"
            ? t("回滿前 15–720 分鐘", "15–720 minutes before full")
            : t(
                `理智量 1–${s.detail?.dungeon?.maxStamina}`,
                `Sanity 1–${s.detail?.dungeon?.maxStamina}`,
              );
      await saveReminderWizardSession(client.db, token, s);
      await interaction.showModal(
        textInput(`reminder:${token}:${action}Submit`, title, value),
      );
      return;
    }

    let keepSession = true;
    try {
      await interaction.deferUpdate();
      if (action === "home") s.page = "home";
      else if (action === "accountsPrev")
        s.accountPage = Math.max(0, s.accountPage - 1);
      else if (action === "accountsNext")
        s.accountPage = Math.min(
          Math.floor((new Set(s.targets.map((r) => r.uid)).size - 1) / 25),
          s.accountPage + 1,
        );
      else if (action === "account") {
        const uid = interaction.values[0];
        if (!s.targets.some((r) => r.uid === uid))
          throw new Error(t("無效帳號", "Invalid account"));
        s.uid = uid;
        s.page = "role";
      } else if (action === "role") {
        const selectedValue = String(interaction.values?.[0] || "");
        const selectedUidForLegacy = s.uid;
        const [selectedUid, selectedServerId, selectedRoleId] =
          selectedValue.split("|");
        const target = selectedRoleId
          ? s.targets.find(
              (r) =>
                r.uid === selectedUid &&
                r.serverId === selectedServerId &&
                r.roleId === selectedRoleId,
            )
          : (() => {
              const matches = s.targets.filter(
                (r) =>
                  `${r.serverId}/${r.roleId}` === selectedValue &&
                  (!selectedUidForLegacy || r.uid === selectedUidForLegacy),
              );
              return matches.length === 1 ? matches[0] : undefined;
            })();
        if (!target) throw new Error(t("無效角色", "Invalid role"));
        s.uid = target.uid;
        const detail = await loadDetail(client, s, target);
        const saved = await client.db.get<ReminderConfig>(
          reminderKey({ ...target, userId: s.owner }),
        );
        s.detail = detail;
        s.config = saved || defaultReminder(s.owner, target, detail, s.legacy);
        // A rule migrated from the old monitor still has a placeholder threshold: show the real one.
        s.config = resolveLegacyThreshold(s.config, detail) ?? s.config;
        s.imported = !saved && !!s.legacy;
        s.page = "destination";
      } else if (s.config) {
        const c = s.config;
        if (["destination", "sanity", "daily"].includes(action))
          s.page = action;
        else if (action === "dm") {
          c.notify_method = "dm";
          delete c.channelId;
          delete c.guildId;
        } else if (action === "mention") c.mention = !c.mention;
        else if (action === "current" || action === "channel") {
          Object.assign(
            c,
            await checkChannel(
              client,
              interaction,
              action === "current"
                ? interaction.channelId
                : interaction.values[0],
            ),
          );
          c.notify_method = "channel";
        } else if (action === "sanityPreset") {
          const value = interaction.values[0];
          if (!["off", "30", "60", "120", "240"].includes(value))
            throw new Error("Invalid preset");
          c.sanity = value === "off" ? "off" : "time";
          c.value = value === "off" ? 60 : Number(value);
        } else if (action === "dailyPreset") {
          const value = interaction.values[0];
          if (!["off", "1", "3", "6", "12"].includes(value))
            throw new Error("Invalid preset");
          c.daily = value !== "off";
          if (c.daily) c.dailyHours = Number(value);
        } else if (action === "asia") c.resetOffset = 8;
        else if (action === "west") c.resetOffset = -5;
        else if (
          ["timeModalSubmit", "amountModalSubmit", "dailyModalSubmit"].includes(
            action,
          )
        ) {
          const raw = interaction.fields.getTextInputValue("value").trim();
          const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
          const max =
            action === "dailyModalSubmit"
              ? 12
              : action === "timeModalSubmit"
                ? 720
                : Number(s.detail?.dungeon?.maxStamina);
          const min = action === "timeModalSubmit" ? 15 : 1;
          if (
            !Number.isInteger(value) ||
            value < min ||
            value > max ||
            !Number.isFinite(max)
          )
            throw new Error(
              t(
                `請輸入 ${min}–${max} 的整數。`,
                `Enter an integer from ${min} to ${max}.`,
              ),
            );
          if (action === "dailyModalSubmit") {
            c.daily = true;
            c.dailyHours = value;
            s.page = "daily";
          } else {
            c.sanity = action === "amountModalSubmit" ? "amount" : "time";
            c.value = value;
            s.page = "sanity";
          }
        } else if (action === "review" || action === "save") {
          if (c.notify_method === "channel")
            Object.assign(
              c,
              await checkChannel(client, interaction, c.channelId!),
            );
          s.detail = await loadDetail(client, s, c);
          validateReminder(c, s.detail);
          if (action === "review") s.page = "review";
          else {
            if (s.page !== "review")
              throw new Error("Review settings before saving");
            client.db.transaction((store) => {
              const accounts = store.get<any[]>(`${c.userId}.accounts`) || [];
              if (!accounts.some((account) => accountId(account) === c.uid))
                throw new Error(
                  "帳號已解除綁定，請重新登入 / Account has been unbound",
                );
              const previous = store.get<ReminderConfig>(reminderKey(c));
              const previousState = store.get<ReminderState>(
                reminderStateKey(c),
              );
              delete c.legacyOffset; // saved by the user: the threshold is theirs now
              c.enabled = c.sanity !== "off" || c.daily;
              c.revision = randomUUID();
              store.set(reminderKey(c), c);
              store.set(reminderStateKey(c), {
                revision: c.revision,
                dailyCycle:
                  previousState?.revision === previous?.revision
                    ? previousState?.dailyCycle
                    : undefined,
                sanitySent:
                  previousState?.revision === previous?.revision &&
                  previous?.sanity === c.sanity &&
                  previous?.value === c.value
                    ? previousState?.sanitySent
                    : false,
              });
            });
            await deleteReminderWizardSession(client.db, token);
            keepSession = false;
            await interaction.editReply({
              attachments: [],
              components: [
                new ContainerBuilder().addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(
                    t(
                      "設定已儲存。只有此角色會套用新設定；下次檢查將於 15 分鐘內執行。",
                      "Saved for this role. The next check runs within 15 minutes.",
                    ),
                  ),
                ),
              ],
            });
            return;
          }
        } else if (action === "disable") {
          client.db.transaction((store) => {
            const saved = store.get<ReminderConfig>(reminderKey(c));
            if (saved)
              store.set(reminderKey(c), {
                ...saved,
                enabled: false,
                revision: randomUUID(),
              });
          });
          s.page = "home";
        } else throw new Error("Invalid action");
      }
      await saveReminderWizardSession(client.db, token, s);
      await render(client, interaction, token, s);
    } catch (error: any) {
      if (keepSession) await saveReminderWizardSession(client.db, token, s);
      await interaction.followUp({
        content: String(error.message).slice(0, 1800),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  } finally {
    activeSessions.delete(token);
  }
}
