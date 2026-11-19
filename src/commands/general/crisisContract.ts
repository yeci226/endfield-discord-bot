import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  AutocompleteInteraction,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { CustomDatabase } from "../../utils/Database";
import { ensureAccountBinding, getAccounts, withAutoRefresh } from "../../utils/accountUtils";
import { getCardDetail, makeRequest } from "../../utils/skportApi";
import { EndfieldRoleEntry, findRoleByKey, listEndfieldRoles, roleKey, roleSelectOptions } from "../../utils/bindingRoles";
import { toI18nLang } from "../../utils/i18n";
import {
  buildCrisisContractCard,
  ContractSummary,
  contractChoices,
  listContracts,
  resolveContract,
} from "../../utils/crisisContractCanvasUtils";

const V2 = MessageFlags.IsComponentsV2;
const FILE_NAME = "crisis-contract.png";
const CACHE_TTL = 10 * 60 * 1000;
const AUTOCOMPLETE_BUDGET_MS = 2200;

// Seasons per Discord user, filled by the command and used by autocomplete (3 s limit, no network wait).
const contractCache = new Map<string, { list: ContractSummary[]; ts: number }>();
function cacheContracts(userId: string, list: ContractSummary[]) {
  if (contractCache.size >= 500) contractCache.delete(contractCache.keys().next().value as string);
  contractCache.set(userId, { list, ts: Date.now() });
}

async function getCrisisContract(
  roleId: string,
  serverId: string,
  userId: string,
  contractId: string,
  locale: string,
  cred: string,
  salt: string,
  options: any = {},
): Promise<any | null> {
  return makeRequest("GET", "https://zonai.skport.com/api/v1/game/endfield/card/crisis-contract", {
    params: { roleId, serverId, userId, contractId },
    cred,
    salt,
    locale,
    ...options,
  });
}

const textPayload = (content: string) => ({
  files: [],
  attachments: [],
  flags: V2,
  components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(content))],
});

function panel(
  tr: any,
  ownerId: string,
  roles: EndfieldRoleEntry[],
  selectedRoleKey: string,
  seasons: ContractSummary[],
  selectedSeasonId: string,
  text: string,
  imageRef: string,
  controls: boolean,
) {
  const container = new ContainerBuilder();
  if (controls && roles.length > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`crisis-contract:role:${ownerId}`)
          .setPlaceholder(tr("l5_SelectRole"))
          .addOptions(roleSelectOptions(roles, selectedRoleKey)),
      ),
    );
  }
  if (controls && seasons.length > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`crisis-contract:season:${ownerId}:${selectedRoleKey}`)
          .setPlaceholder(tr("crisis_SelectSeason"))
          .addOptions(
            seasons.slice(0, 25).map((c) => ({
              label: c.name.slice(0, 100),
              value: c.id,
              description: `${c.highest ?? 0} · ${c.challengeCount ?? 0}`,
              emoji: "📜",
              default: c.id === selectedSeasonId,
            })),
          ),
      ),
    );
  }
  container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(imageRef)));
  if (text) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (controls) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`crisis-contract:close:${ownerId}`).setLabel(`✖ ${tr("l5_Close")}`).setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return container;
}

async function resolveRoles(client: ExtendedClient, userId: string, tr: any) {
  const accounts = await getAccounts(client.db, userId);
  if (!accounts || accounts.length === 0) return { accounts, roles: [] as EndfieldRoleEntry[], error: tr("NoSetAccount") };
  let roles = listEndfieldRoles(accounts);
  if (roles.length === 0) {
    for (const account of accounts) await ensureAccountBinding(account, userId, client.db, tr.lang).catch(() => false);
    roles = listEndfieldRoles(accounts);
  }
  if (roles.length === 0) return { accounts, roles, error: tr("l5_NoRole") };
  return { accounts, roles, error: undefined as string | undefined };
}

async function render(client: ExtendedClient, userId: string, tr: any, selectedRoleKey?: string, requestedSeason?: string | null) {
  const { accounts, roles, error } = await resolveRoles(client, userId, tr);
  if (error) return textPayload(error);
  const role = findRoleByKey(roles, selectedRoleKey) ?? roles[0];
  const account = accounts[role.accountIndex];
  if (account.invalid) await ensureAccountBinding(account, userId, client.db, tr.lang).catch(() => false);

  let out: { detailRes: any; res: any; seasons: ContractSummary[]; contract?: ContractSummary; problem?: "none" | "notFound" };
  try {
    out = await withAutoRefresh(
      client,
      userId,
      account,
      async (cred: string, salt: string, options: any) => {
        const detailRes: any = await getCardDetail(role.roleId, role.serverId, role.skUserId, tr.lang, cred, salt, options);
        const seasons = listContracts(detailRes?.data?.detail);
        const pick = resolveContract(seasons, requestedSeason);
        if ("error" in pick) return { detailRes, res: null, seasons, problem: pick.error };
        const res = await getCrisisContract(role.roleId, role.serverId, role.skUserId, pick.contract.id, tr.lang, cred, salt, options);
        return { detailRes, res, seasons, contract: pick.contract };
      },
      tr.lang,
    );
  } catch (e: any) {
    if (e?.message === "TokenExpired") return textPayload(tr("TokenExpired"));
    throw e;
  }

  if (!out.detailRes || out.detailRes.code !== 0) {
    return textPayload(out.detailRes?.code === 10000 ? tr("TokenExpired") : `${tr("Error")} (API Code: ${out.detailRes?.code ?? "NULL"})`);
  }
  cacheContracts(userId, out.seasons);
  if (out.problem === "none") return textPayload(tr("crisis_NoContract"));
  if (out.problem === "notFound") return textPayload(tr("crisis_SeasonNotFound"));
  if (!out.res || out.res.code !== 0) return textPayload(tr("crisis_FetchFailed", { code: out.res?.code ?? "unknown" }));

  const contract = out.contract!;
  const crisisContract = out.res.data?.crisisContract;
  const status = crisisContract?.status || {};
  const detail = out.detailRes.data?.detail;
  const roleName = detail?.base?.name || role.nickname || role.roleId;
  const png = await buildCrisisContractCard({
    roleName,
    roleLevel: Number(detail?.base?.level || role.level || 0),
    crisisContract,
    detail,
    tr,
  });
  const frac = (m: any) => `${m?.count ?? 0}/${m?.total ?? 0}`;
  const text = tr("crisis_Msg", {
    name: status.name || contract.name || tr("crisis_Title"),
    role: roleName,
    highest: status.highest ?? 0,
    challenges: status.challengeCount ?? 0,
    weekly: frac(status.weeklyMission),
    indicator: frac(status.indicatorMission),
    stage: frac(status.stageMission),
    indicators: crisisContract?.indicators?.length ?? 0,
    records: crisisContract?.history?.records?.length ?? 0,
  });
  return {
    files: [new AttachmentBuilder(png, { name: FILE_NAME })],
    attachments: [],
    flags: V2,
    components: [panel(tr, userId, roles, roleKey(role), out.seasons, contract.id, text, `attachment://${FILE_NAME}`, true)],
  };
}

/** Seasons for autocomplete: cache first, else one bounded fetch without any token refresh. */
async function seasonsForAutocomplete(client: ExtendedClient, db: CustomDatabase, userId: string, locale: string): Promise<ContractSummary[]> {
  const hit = contractCache.get(userId);
  if (hit && Date.now() - hit.ts <= CACHE_TTL) return hit.list;
  const accounts = await getAccounts(db, userId);
  const role = listEndfieldRoles(accounts)[0];
  if (!role) return [];
  const account = accounts[role.accountIndex];
  if (account.invalid) return [];
  const lang = toI18nLang(locale);
  const fetched = Promise.resolve(getCardDetail(role.roleId, role.serverId, role.skUserId, lang, account.cred, account.salt))
    .then((res: any) => (res?.code === 0 ? listContracts(res.data?.detail) : []))
    .catch(() => [] as ContractSummary[]);
  const list = await Promise.race([fetched, new Promise<ContractSummary[]>((r) => setTimeout(() => r([]), AUTOCOMPLETE_BUDGET_MS))]);
  if (list.length) cacheContracts(userId, list);
  return list;
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("crisis-contract")
    .setDescription("View your Endfield Crisis Contract results")
    .setNameLocalizations({ "zh-TW": "危機合約" })
    .setDescriptionLocalizations({ "zh-TW": "查看終末地危機合約賽季戰績" })
    .addStringOption((option) =>
      option
        .setName("season")
        .setDescription("Season to view (default: newest)")
        .setNameLocalizations({ "zh-TW": "賽季" })
        .setDescriptionLocalizations({ "zh-TW": "選擇要查看的賽季（預設為最新）" })
        .setAutocomplete(true)
        .setRequired(false),
    ) as SlashCommandBuilder,

  autocomplete: async (client: ExtendedClient, interaction: AutocompleteInteraction, db: CustomDatabase) => {
    let choices: Array<{ name: string; value: string }> = [];
    try {
      const list = await seasonsForAutocomplete(client, db, interaction.user.id, interaction.locale);
      choices = contractChoices(list, interaction.options.getFocused());
    } catch {
      choices = [];
    }
    await interaction.respond(choices).catch(() => {});
  },

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    const i = interaction as any;

    // Components of an earlier reply: crisis-contract:<action>:<ownerId>[:<roleKey>]
    if (i.isStringSelectMenu?.() || i.isButton?.()) {
      const [, action, ownerId, ...rest] = String(i.customId).split(":");
      if (ownerId !== i.user.id) {
        await i.reply({ content: tr("l5_NotOwner"), flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      if (action === "close") {
        const existing = i.message?.attachments?.first?.()?.url;
        const container = new ContainerBuilder().addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(existing || `attachment://${FILE_NAME}`)),
        );
        const textDisplay = (i.message?.components?.[0]?.components ?? []).find((c: any) => c?.type === 10 && typeof c.content === "string");
        if (textDisplay) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(textDisplay.content));
        await i.update({ components: [container], flags: V2 });
        return;
      }
      if (i.isStringSelectMenu?.() && (action === "role" || action === "season")) {
        await i.deferUpdate();
        const value = i.values?.[0];
        const payload =
          action === "role"
            ? await render(client, i.user.id, tr, value)
            : await render(client, i.user.id, tr, rest.join(":"), value);
        await i.editReply(payload);
      }
      return;
    }

    if (!i.isChatInputCommand?.()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral | V2 });
    await i.editReply(await render(client, i.user.id, tr, undefined, i.options.getString("season")));
  },
};

export default command;
