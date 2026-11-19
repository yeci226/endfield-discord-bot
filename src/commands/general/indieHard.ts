import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  AutocompleteInteraction,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { CustomDatabase } from "../../utils/Database";
import { makeRequest } from "../../utils/skportApi";
import {
  getAccounts,
  ensureAccountBinding,
  withAutoRefresh,
} from "../../utils/accountUtils";
import {
  ENDFIELD_GAME_ID,
  getPrimaryBindingRoleForGame,
  resolveEndfieldTarget,
} from "../../utils/bindingRoles";
import {
  buildIndieHardCard,
  IndieHardGroup,
} from "../../utils/indieHardCanvasUtils";
import { createTranslator, toI18nLang } from "../../utils/i18n";
import { isTokenExpiredError } from "../../services/autoDailyPlan";

// Module-level cache: `${userId}:${accountIndex}` -> groups (expires after 10 min)
const groupCache = new Map<string, { groups: IndieHardGroup[]; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;
const cacheKey = (userId: string, accountIndex: number) =>
  `${userId}:${accountIndex}`;

const SELECT_PREFIX = "影拓豐碑:select:";

/** customId: `影拓豐碑:select:<userId>[:<accountIndex>]` (old ids have no index). */
function parseSelectId(customId: string): { accountIndex: number } {
  const parts = customId.slice(SELECT_PREFIX.length).split(":");
  const parsed = Number.parseInt(parts[1] ?? "0", 10);
  return { accountIndex: Number.isInteger(parsed) && parsed >= 0 ? parsed : 0 };
}

const REASON_KEY = {
  no_account: "indieHard_NoAccount",
  account_not_found: "indieHard_AccountNotFound",
  no_endfield_role: "indieHard_NoEndfieldRole",
} as const;

async function getIndieHard(
  roleId: string,
  serverId: string,
  userId: string,
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<{ indieHardGroups: IndieHardGroup[] } | null> {
  const url =
    "https://zonai.skport.com/api/v1/game/endfield/card/indie-hard";
  const res = await makeRequest<{
    code: number;
    data: { indieHard: { indieHardGroups: IndieHardGroup[] } };
  }>("GET", url, {
    params: { roleId, serverId, userId },
    cred,
    locale,
    salt,
    ...options,
  });
  if (!res || (res as any).code !== 0) return null;
  return (res as any).data?.indieHard ?? null;
}

/** Fetches the groups with auto-refresh on a stale token. */
async function fetchGroups(
  client: ExtendedClient,
  discordUserId: string,
  account: any,
  role: { roleId: string; serverId: string; bindingUid?: string },
  locale: string,
): Promise<{ indieHardGroups: IndieHardGroup[] } | null> {
  // Same `userId` parameter as before this change: the binding uid, else the SKPort id.
  const skUserId = String(role.bindingUid || account.info?.id || "");
  return withAutoRefresh(
    client,
    discordUserId,
    account,
    (c: string, s: string, options: any) =>
      getIndieHard(role.roleId, role.serverId, skUserId, locale, c, s, options),
    locale,
  );
}

async function fetchAndCacheGroups(
  client: ExtendedClient,
  db: CustomDatabase,
  discordUserId: string,
  accountIndex: number | null,
  locale: string,
): Promise<
  | { groups: IndieHardGroup[]; accountIndex: number; error: null }
  | { groups: null; accountIndex: number; error: string }
> {
  const tr = createTranslator(toI18nLang(locale));
  const accounts = await getAccounts(db, discordUserId);
  let target = resolveEndfieldTarget(accounts, accountIndex);
  if (!target.ok) {
    return { groups: null, accountIndex: accountIndex ?? 0, error: tr(REASON_KEY[target.reason]) };
  }

  // Refresh the binding first; it may add the Endfield role or fix the credentials.
  await ensureAccountBinding(target.account, discordUserId, db, locale);
  target = resolveEndfieldTarget(accounts, target.accountIndex);
  if (!target.ok) {
    return { groups: null, accountIndex: accountIndex ?? 0, error: tr(REASON_KEY[target.reason]) };
  }

  let data: { indieHardGroups: IndieHardGroup[] } | null = null;
  try {
    data = await fetchGroups(client, discordUserId, target.account, target.role, locale);
  } catch (err) {
    if (isTokenExpiredError(err)) {
      return { groups: null, accountIndex: target.accountIndex, error: tr("TokenExpired") };
    }
    console.error("[indieHard] API error:", err);
  }

  if (!data || !data.indieHardGroups || data.indieHardGroups.length === 0) {
    return { groups: null, accountIndex: target.accountIndex, error: tr("indieHard_APIFailed") };
  }

  groupCache.set(cacheKey(discordUserId, target.accountIndex), {
    groups: data.indieHardGroups,
    ts: Date.now(),
  });
  return { groups: data.indieHardGroups, accountIndex: target.accountIndex, error: null };
}

async function sendGroupCard(
  interaction:
    | ChatInputCommandInteraction
    | StringSelectMenuInteraction,
  groups: IndieHardGroup[],
  groupIndex: number,
  accountIndex: number,
  locale: string,
) {
  const tr = createTranslator(toI18nLang(locale));
  const group = groups[groupIndex];

  let imgBuffer: Buffer;
  try {
    imgBuffer = await buildIndieHardCard(group);
  } catch (err: any) {
    console.error("[indieHard] Canvas error:", err);
    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(tr("indieHard_CanvasFailed")),
    );
    await interaction.editReply({
      flags: (1 << 15) | MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  const attachment = new AttachmentBuilder(imgBuffer, {
    name: "indie-hard.png",
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`${SELECT_PREFIX}${interaction.user.id}:${accountIndex}`)
    .setPlaceholder(tr("indieHard_SelectPeriod"))
    .addOptions(
      groups.map((g, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(g.activityName)
          .setValue(String(i))
          .setDefault(i === groupIndex),
      ),
    );

  await interaction.editReply({
    files: [attachment],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        selectMenu,
      ),
    ],
  });
}

function accountLabel(account: any, accountIndex: number, isZh: boolean): string {
  const name = `${account?.info?.nickname || "Unknown"}`;
  const id = `${account?.info?.id || "-"}`;
  const role = getPrimaryBindingRoleForGame(account?.roles, ENDFIELD_GAME_ID);
  const none = isZh ? "無" : "None";
  return `${accountIndex + 1}. ${name} (${id}) | ${isZh ? "終末地" : "Endfield"}: ${role?.nickname || none}`.slice(0, 100);
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("indie-hard")
    .setDescription("View Indie Hard Mode progress")
    .setNameLocalizations({
      "zh-TW": "影拓豐碑",
      "zh-CN": "影拓丰碑",
    })
    .setDescriptionLocalizations({
      "zh-TW": "查看影拓豐碑（獨立困難模式）進度",
      "zh-CN": "查看影拓丰碑（独立困难模式）进度",
    })
    .addStringOption((option) =>
      option
        .setName("period")
        .setDescription("Select a period to view")
        .setNameLocalizations({ "zh-TW": "期數", "zh-CN": "期数" })
        .setDescriptionLocalizations({
          "zh-TW": "選擇要查看的期數",
          "zh-CN": "选择要查看的期数",
        })
        .setAutocomplete(true)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("account")
        .setDescription("Select which bound account to use")
        .setNameLocalizations({ "zh-TW": "帳號", "zh-CN": "账号" })
        .setDescriptionLocalizations({
          "zh-TW": "選擇要使用的綁定帳號",
          "zh-CN": "选择要使用的绑定账号",
        })
        .setAutocomplete(true)
        .setRequired(false),
    ) as SlashCommandBuilder,

  autocomplete: async (
    client: ExtendedClient,
    interaction: AutocompleteInteraction,
    db: CustomDatabase,
  ) => {
    const focused = interaction.options.getFocused(true);
    const query = String(focused.value || "").toLowerCase();
    const discordUserId = interaction.user.id;
    const accounts = await getAccounts(db, discordUserId);
    if (!accounts || accounts.length === 0) {
      await interaction.respond([]);
      return;
    }

    // Account picker: stored data only, no network.
    if (focused.name === "account") {
      const isZh = interaction.locale === "zh-TW";
      await interaction.respond(
        accounts
          .map((acc: any, i: number) => ({
            name: accountLabel(acc, i, isZh),
            value: String(i),
          }))
          .filter((c) => c.name.toLowerCase().includes(query))
          .slice(0, 25),
      );
      return;
    }

    // Period picker (for the chosen account, default as in execute()).
    const rawAccount = interaction.options.getString("account");
    const requested = rawAccount === null ? null : Number(rawAccount);
    const target = resolveEndfieldTarget(accounts, requested);
    if (!target.ok) {
      await interaction.respond([]);
      return;
    }

    const key = cacheKey(discordUserId, target.accountIndex);
    const entry = groupCache.get(key);
    if (entry && Date.now() - entry.ts <= CACHE_TTL) {
      const choices = entry.groups
        .map((g, i) => ({ name: g.activityName, value: String(i) }))
        .filter((c) => c.name.toLowerCase().includes(query));
      await interaction.respond(choices.slice(0, 25));
      return;
    }

    try {
      // Autocomplete cannot be deferred: stay well inside Discord's 3 s.
      const data = await withTimeout(
        fetchGroups(client, discordUserId, target.account, target.role, interaction.locale),
        2000,
      );
      if (data?.indieHardGroups) {
        groupCache.set(key, { groups: data.indieHardGroups, ts: Date.now() });
        const choices = data.indieHardGroups
          .map((g, i) => ({ name: g.activityName, value: String(i) }))
          .filter((c) => c.name.toLowerCase().includes(query));
        await interaction.respond(choices.slice(0, 25));
        return;
      }
    } catch (err) {
      console.error("[indieHard] autocomplete error:", err);
    }
    await interaction.respond([]);
  },

  execute: async (
    client: ExtendedClient,
    interaction:
      | ChatInputCommandInteraction
      | ModalSubmitInteraction
      | StringSelectMenuInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    // ── Handle SelectMenu interaction ────────────────────────────────────
    if ((interaction as StringSelectMenuInteraction).isStringSelectMenu?.()) {
      const sel = interaction as StringSelectMenuInteraction;
      if (!sel.customId.startsWith(SELECT_PREFIX)) return;
      await sel.deferUpdate();

      const selTr = createTranslator(toI18nLang(sel.locale));
      const { accountIndex } = parseSelectId(sel.customId);
      const entry = groupCache.get(cacheKey(sel.user.id, accountIndex));
      if (!entry || Date.now() - entry.ts > CACHE_TTL) {
        await sel.editReply({ content: selTr("indieHard_DataExpired"), components: [] });
        return;
      }
      const idx = parseInt(sel.values[0]) || 0;
      await sendGroupCard(sel as any, entry.groups, idx, accountIndex, sel.locale);
      return;
    }

    if (!(interaction as ChatInputCommandInteraction).isChatInputCommand?.()) return;
    const ci = interaction as ChatInputCommandInteraction;
    await ci.deferReply({ flags: (1 << 15) | MessageFlags.Ephemeral });

    const ciTr = createTranslator(toI18nLang(ci.locale));
    const discordUserId = ci.user.id;

    const rawAccount = ci.options.getString("account");
    const requested = rawAccount === null ? null : Number(rawAccount);

    // Get groups (use cache or fetch)
    let groups: IndieHardGroup[];
    let accountIndex: number;
    const accounts = await getAccounts(db, discordUserId);
    const target = resolveEndfieldTarget(accounts, requested);
    const cached = target.ok
      ? groupCache.get(cacheKey(discordUserId, target.accountIndex))
      : undefined;
    if (target.ok && cached && Date.now() - cached.ts <= CACHE_TTL) {
      groups = cached.groups;
      accountIndex = target.accountIndex;
    } else {
      const result = await fetchAndCacheGroups(client, db, discordUserId, requested, ci.locale);
      if (result.error || !result.groups) {
        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(result.error ?? ciTr("indieHard_UnknownError")),
        );
        await ci.editReply({
          flags: (1 << 15) | MessageFlags.IsComponentsV2,
          components: [container],
        });
        return;
      }
      groups = result.groups;
      accountIndex = result.accountIndex;
    }

    // Determine which group to show
    const periodValue = ci.options.getString("period");
    let groupIndex = 0;
    if (periodValue !== null) {
      const parsed = parseInt(periodValue);
      if (!isNaN(parsed) && parsed >= 0 && parsed < groups.length) {
        groupIndex = parsed;
      }
    }

    await sendGroupCard(ci as any, groups, groupIndex, accountIndex, ci.locale);
  },
};

export default command;
