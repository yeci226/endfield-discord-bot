import { randomUUID } from "crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from "discord.js";
import type { ExtendedClient } from "../structures/Client";
import { getAccounts } from "./accountUtils";
import {
  nextDailyReset,
  ReminderConfig,
  ReminderState,
  reminderKey,
  reminderStateKey,
  reminderTargets,
} from "./reminders";

export const LIST_PAGE_SIZE = 10;
export const LIST_PREFIX = "reminder:list:";

export interface ListRule {
  config: ReminderConfig;
  state: ReminderState | null;
  accountName: string;
}

/** `uid.serverId.roleId`: identifies a rule inside one user's rules (the user id is never put in a customId). */
export const ruleSuffix = (c: Pick<ReminderConfig, "uid" | "serverId" | "roleId">) =>
  `${c.uid}.${c.serverId}.${c.roleId}`;

export function keyFromSuffix(userId: string, suffix: string): string | null {
  return /^\d+\.\d+\.\d+$/.test(suffix) ? `reminder.v2.${userId}.${suffix}` : null;
}

export type RuleStatus = "active" | "paused" | "system" | "retry";

export function ruleStatus(
  config: ReminderConfig,
  state: ReminderState | null,
  now: number,
): RuleStatus {
  if (!config.enabled) return "paused";
  if (state?.revision === config.revision) {
    if (state.disabledReason) return "system";
    if ((state.retryAt || 0) > now) return "retry";
  }
  return "active";
}

/**
 * When the daily reminder window next opens (never earlier than `now`), or
 * null when the rule has no daily part / unknown reset region. Sanity
 * reminders have no fixed time: they fire when a poll sees the condition.
 */
export function nextDailyAt(
  config: ReminderConfig,
  state: ReminderState | null,
  now: number,
): number | null {
  if (!config.daily || config.resetOffset == null) return null;
  let reset = nextDailyReset(now, config.resetOffset);
  const fresh = state?.revision === config.revision ? state : null;
  if (fresh?.dailyCycle === reset) reset += 86400000;
  return Math.max(now, reset - config.dailyHours * 3600000);
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
}

export function clampPage(page: number, total: number): number {
  const n = Number.isFinite(page) ? Math.trunc(page) : 0;
  return Math.min(Math.max(0, n), pageCount(total) - 1);
}

export function sortRules<T extends { config: ReminderConfig }>(rules: T[]): T[] {
  return [...rules].sort(
    (a, b) =>
      a.config.name.localeCompare(b.config.name) ||
      ruleSuffix(a.config).localeCompare(ruleSuffix(b.config)),
  );
}

const ts = (ms: number) => Math.floor(ms / 1000);
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const typeIcons = (c: ReminderConfig) =>
  `${c.sanity !== "off" ? "⚡" : ""}${c.daily ? "📅" : ""}` || "🔔";
const statusIcon: Record<RuleStatus, string> = {
  active: "🟢",
  paused: "⏸️",
  system: "⚠️",
  retry: "🔁",
};

interface ListView {
  rules: ListRule[];
  page: number;
  selected?: string;
  confirmDelete?: boolean;
  now: number;
}

function targetText(c: ReminderConfig, tr: any): string {
  return c.notify_method === "channel" && c.channelId
    ? `<#${c.channelId}>`
    : `💬 ${tr("reminderList_TargetDm")}`;
}

function nextText(rule: ListRule, status: RuleStatus, now: number, tr: any): string {
  if (status === "paused" || status === "system") return "";
  const parts: string[] = [];
  if (status === "retry" && rule.state?.retryAt)
    parts.push(`🔁 <t:${ts(rule.state.retryAt)}:R>`);
  const daily = nextDailyAt(rule.config, rule.state, now);
  if (daily != null) parts.push(`📅 <t:${ts(daily)}:R>`);
  if (rule.config.sanity !== "off") parts.push(`⚡ ${tr("reminderList_CheckEvery")}`);
  return parts.join(" · ");
}

/** Message payload for the list screen. Pure: depends only on its arguments. */
export function buildReminderListPayload(view: ListView, tr: any): any {
  const sorted = sortRules(view.rules);
  const page = clampPage(view.page, sorted.length);
  const pages = pageCount(sorted.length);
  const visible = sorted.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
  const selected = visible.find((r) => ruleSuffix(r.config) === view.selected);
  const container = new ContainerBuilder();
  const row = (...components: any[]) => new ActionRowBuilder<any>().addComponents(...components);
  const button = (id: string, label: string, style: ButtonStyle, emoji?: string, disabled = false) => {
    const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
    if (emoji) b.setEmoji(emoji);
    return b;
  };
  const closeButton = () => button(`${LIST_PREFIX}close`, tr("reminderList_Close"), ButtonStyle.Secondary, "✖️");

  if (!sorted.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 🔔 ${tr("reminderList_Title")}\n${tr("reminderList_Empty")}`),
    );
    container.addActionRowComponents(row(closeButton()));
    return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
  }

  const lines = visible.map((r) => {
    const status = ruleStatus(r.config, r.state, view.now);
    const mark = selected && ruleSuffix(r.config) === ruleSuffix(selected.config) ? "▶ " : "";
    const next = nextText(r, status, view.now, tr);
    return (
      `${mark}${typeIcons(r.config)} **${r.config.name}** · ${r.accountName}\n` +
      `-# ${statusIcon[status]} ${tr("reminderList_Status_" + status)} · ${targetText(r.config, tr)}${next ? " · " + next : ""}`
    );
  });
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🔔 ${tr("reminderList_Title")}\n${lines.join("\n")}` +
        (pages > 1 ? `\n-# ${tr("reminderList_Page", { page: page + 1, pages })}` : ""),
    ),
  );

  if (view.confirmDelete && selected) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🗑️ ${tr("reminderList_ConfirmDelete", { name: selected.config.name })}`),
    );
    const suffix = ruleSuffix(selected.config);
    container.addActionRowComponents(
      row(
        button(`${LIST_PREFIX}delok:${page}:${suffix}`, tr("reminderList_ConfirmYes"), ButtonStyle.Danger, "🗑️"),
        button(`${LIST_PREFIX}pg:${page}:${suffix}`, tr("reminderList_Cancel"), ButtonStyle.Secondary, "↩️"),
        closeButton(),
      ),
    );
    return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
  }

  container.addActionRowComponents(
    row(
      new StringSelectMenuBuilder()
        .setCustomId(`${LIST_PREFIX}sel:${page}`)
        .setPlaceholder(tr("reminderList_SelectPlaceholder"))
        .addOptions(
          visible.map((r) => {
            const status = ruleStatus(r.config, r.state, view.now);
            return {
              label: truncate(`${typeIcons(r.config)} ${r.config.name}`, 100),
              description: truncate(`${r.accountName} · ${tr("reminderList_Status_" + status)}`, 100),
              value: ruleSuffix(r.config),
              default: !!selected && ruleSuffix(selected.config) === ruleSuffix(r.config),
            };
          }),
        ),
    ),
  );

  const suffix = selected ? ruleSuffix(selected.config) : "0.0.0";
  const selectedStatus = selected ? ruleStatus(selected.config, selected.state, view.now) : "active";
  const resumable = selectedStatus === "paused" || selectedStatus === "system";
  container.addActionRowComponents(
    row(
      button(
        `${LIST_PREFIX}toggle:${page}:${suffix}`,
        tr(resumable ? "reminderList_Resume" : "reminderList_Pause"),
        resumable ? ButtonStyle.Success : ButtonStyle.Primary,
        resumable ? "▶️" : "⏸️",
        !selected,
      ),
      button(`${LIST_PREFIX}del:${page}:${suffix}`, tr("reminderList_Delete"), ButtonStyle.Danger, "🗑️", !selected),
      closeButton(),
    ),
  );
  if (pages > 1)
    container.addActionRowComponents(
      row(
        button(`${LIST_PREFIX}pg:${page - 1}`, tr("reminderList_Prev"), ButtonStyle.Secondary, "◀️", page === 0),
        button(`${LIST_PREFIX}pg:${page + 1}`, tr("reminderList_NextPage"), ButtonStyle.Secondary, "▶️", page >= pages - 1),
      ),
    );
  return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
}

// ------------------------------------------------------------ data access

export async function loadListRules(client: ExtendedClient, userId: string): Promise<ListRule[]> {
  const stored = await client.db.findByPrefix<ReminderConfig>(`reminder.v2.${userId}.`);
  let accountNames = new Map<string, string>();
  try {
    accountNames = new Map(
      reminderTargets(await getAccounts(client.db, userId)).map((t) => [t.uid, t.accountName]),
    );
  } catch {
    // account names are decoration; the list still works without them
  }
  const rules: ListRule[] = [];
  for (const { value } of stored) {
    if (!value || value.version !== 2 || value.userId !== userId) continue;
    rules.push({
      config: value,
      state: await client.db.get<ReminderState>(reminderStateKey(value)),
      accountName: accountNames.get(value.uid) || value.uid,
    });
  }
  return rules;
}

/** Pause/resume: bumping the revision resets the rule's state (including a system pause). Returns the new enabled flag, or null if the rule is gone. */
export function toggleRule(client: ExtendedClient, userId: string, suffix: string): boolean | null {
  const key = keyFromSuffix(userId, suffix);
  if (!key) return null;
  return client.db.transaction((store) => {
    const cur = store.get<ReminderConfig>(key);
    if (!cur) return null;
    const state = store.get<ReminderState>(reminderStateKey(cur));
    const systemPaused = state?.revision === cur.revision && !!state.disabledReason;
    // Paused (by the user or the system) -> enabled again; otherwise -> paused.
    const enabled = !cur.enabled || systemPaused;
    store.set(key, { ...cur, enabled, revision: randomUUID() });
    return enabled;
  });
}

/** Deletes the rule and its state row. Returns false when it did not exist. */
export function deleteRule(client: ExtendedClient, userId: string, suffix: string): boolean {
  const key = keyFromSuffix(userId, suffix);
  if (!key) return false;
  return client.db.transaction((store) => {
    const cur = store.get<ReminderConfig>(key);
    if (!cur) return false;
    store.delete(key);
    store.delete(reminderStateKey(cur));
    return true;
  });
}

// ------------------------------------------------------------ interactions

/** `/reminder list` */
export async function reminderList(client: ExtendedClient, interaction: any, tr: any): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rules = await loadListRules(client, interaction.user.id);
  await interaction.editReply(buildReminderListPayload({ rules, page: 0, now: Date.now() }, tr));
}

/** Buttons and the select menu of the list screen (customId `reminder:list:<action>:...`). */
export async function reminderListComponent(client: ExtendedClient, interaction: any, tr: any): Promise<void> {
  const userId = interaction.user.id;
  const [, , action, a, b] = String(interaction.customId).split(":");
  await interaction.deferUpdate();
  if (action === "close") {
    try {
      await interaction.deleteReply();
    } catch {
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`✖️ ${tr("reminderList_Closed")}`))],
      });
    }
    return;
  }
  let page = Number(a);
  let selected: string | undefined;
  let confirmDelete = false;
  let notice: string | undefined;
  if (action === "sel") selected = String(interaction.values?.[0] ?? "");
  else if (action === "pg") selected = b || undefined;
  else if (action === "toggle") {
    const enabled = toggleRule(client, userId, String(b));
    notice = enabled === null ? tr("reminderList_Gone") : tr(enabled ? "reminderList_Resumed" : "reminderList_Paused");
    selected = enabled === null ? undefined : String(b);
  } else if (action === "del") {
    selected = String(b);
    confirmDelete = true;
  } else if (action === "delok") {
    notice = deleteRule(client, userId, String(b)) ? tr("reminderList_Deleted") : tr("reminderList_Gone");
  }
  const rules = await loadListRules(client, userId);
  const payload = buildReminderListPayload({ rules, page, selected, confirmDelete, now: Date.now() }, tr);
  await interaction.editReply(payload);
  if (notice) await interaction.followUp({ content: notice, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
