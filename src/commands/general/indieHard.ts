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
  getPrimaryBindingRole,
} from "../../utils/accountUtils";
import {
  buildIndieHardCard,
  IndieHardGroup,
} from "../../utils/indieHardCanvasUtils";
import { createTranslator, toI18nLang } from "../../utils/i18n";

// Module-level cache: userId -> groups (expires after 10 min)
const groupCache = new Map<string, { groups: IndieHardGroup[]; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;

async function getIndieHard(
  roleId: string,
  serverId: string,
  userId: string,
  locale?: string,
  cred?: string,
  salt?: string,
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
  });
  if (!res || (res as any).code !== 0) return null;
  return (res as any).data?.indieHard ?? null;
}

async function fetchAndCacheGroups(
  db: CustomDatabase,
  discordUserId: string,
  locale: string,
): Promise<
  | { groups: IndieHardGroup[]; error: null }
  | { groups: null; error: string }
> {
  const tr = createTranslator(toI18nLang(locale));
  const accounts = await getAccounts(db, discordUserId);
  if (!accounts || accounts.length === 0) {
    return { groups: null, error: tr("indieHard_NoAccount") };
  }

  const account = accounts[0];
  const primary = getPrimaryBindingRole(account.roles, 3);
  if (!primary) {
    return { groups: null, error: tr("indieHard_RoleNotFound") };
  }

  const { role, binding } = primary;
  const roleId = String(role.roleId || "");
  const serverId = String(role.serverId || "");
  const skUserId = String(binding?.uid || account.info?.id || "");

  let data: { indieHardGroups: IndieHardGroup[] } | null = null;
  try {
    data = await getIndieHard(roleId, serverId, skUserId, locale, account.cred, account.salt);
  } catch (err) {
    console.error("[indieHard] API error:", err);
  }

  if (!data || !data.indieHardGroups || data.indieHardGroups.length === 0) {
    return { groups: null, error: tr("indieHard_APIFailed") };
  }

  groupCache.set(discordUserId, { groups: data.indieHardGroups, ts: Date.now() });
  return { groups: data.indieHardGroups, error: null };
}

async function sendGroupCard(
  interaction:
    | ChatInputCommandInteraction
    | StringSelectMenuInteraction,
  groups: IndieHardGroup[],
  groupIndex: number,
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
    .setCustomId(`影拓豐碑:select:${interaction.user.id}`)
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
    ) as SlashCommandBuilder,

  autocomplete: async (
    _client: ExtendedClient,
    interaction: AutocompleteInteraction,
    db: CustomDatabase,
  ) => {
    const focusedValue = interaction.options.getFocused().toLowerCase();
    const discordUserId = interaction.user.id;

    // Try cache first
    const entry = groupCache.get(discordUserId);
    if (entry && Date.now() - entry.ts <= CACHE_TTL) {
      const choices = entry.groups
        .map((g, i) => ({ name: g.activityName, value: String(i) }))
        .filter((c) => c.name.toLowerCase().includes(focusedValue));
      await interaction.respond(choices.slice(0, 25));
      return;
    }

    // Fetch fresh data
    const accounts = await getAccounts(db, discordUserId);
    if (!accounts || accounts.length === 0) {
      await interaction.respond([]);
      return;
    }
    const account = accounts[0];
    const primary = getPrimaryBindingRole(account.roles, 3);
    if (!primary) {
      await interaction.respond([]);
      return;
    }
    const { role, binding } = primary;
    const roleId = String(role.roleId || "");
    const serverId = String(role.serverId || "");
    const skUserId = String(binding?.uid || account.info?.id || "");

    try {
      const data = await getIndieHard(
        roleId, serverId, skUserId,
        interaction.locale, account.cred, account.salt,
      );
      if (data?.indieHardGroups) {
        groupCache.set(discordUserId, { groups: data.indieHardGroups, ts: Date.now() });
        const choices = data.indieHardGroups
          .map((g, i) => ({ name: g.activityName, value: String(i) }))
          .filter((c) => c.name.toLowerCase().includes(focusedValue));
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
      if (!sel.customId.startsWith("影拓豐碑:select:")) return;
      await sel.deferUpdate();

      const selTr = createTranslator(toI18nLang(sel.locale));
      const entry = groupCache.get(sel.user.id);
      if (!entry || Date.now() - entry.ts > CACHE_TTL) {
        await sel.editReply({ content: selTr("indieHard_DataExpired"), components: [] });
        return;
      }
      const idx = parseInt(sel.values[0]) || 0;
      await sendGroupCard(sel as any, entry.groups, idx, sel.locale);
      return;
    }

    if (!(interaction as ChatInputCommandInteraction).isChatInputCommand?.()) return;
    const ci = interaction as ChatInputCommandInteraction;
    await ci.deferReply({ flags: (1 << 15) | MessageFlags.Ephemeral });

    const ciTr = createTranslator(toI18nLang(ci.locale));
    const discordUserId = ci.user.id;

    // Ensure account binding
    const accounts = await getAccounts(db, discordUserId);
    if (accounts && accounts.length > 0) {
      await ensureAccountBinding(accounts[0], discordUserId, db, ci.locale);
    }

    // Get groups (use cache or fetch)
    let groups: IndieHardGroup[];
    const cached = groupCache.get(discordUserId);
    if (cached && Date.now() - cached.ts <= CACHE_TTL) {
      groups = cached.groups;
    } else {
      const result = await fetchAndCacheGroups(db, discordUserId, ci.locale);
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

    await sendGroupCard(ci as any, groups, groupIndex, ci.locale);
  },
};

export default command;
