import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
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
import { getCardDetail } from "../../utils/skportApi";
import { EndfieldRoleEntry, findRoleByKey, listEndfieldRoles, roleKey, roleSelectOptions } from "../../utils/endfieldRole";
import { buildStaminaView, staminaMessageText, StaminaView } from "../../utils/staminaView";
import { buildStaminaCard } from "../../utils/staminaCanvasUtils";

const FILE_NAME = "stamina.png";
const V2 = MessageFlags.IsComponentsV2;

const textPayload = (content: string) => ({
  files: [],
  attachments: [],
  flags: V2,
  components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(content))],
});

/** Container: [role picker] / card image / summary line / [close]. */
function panel(tr: any, ownerId: string, roles: EndfieldRoleEntry[], selectedKey: string, text: string, imageRef: string, controls: boolean) {
  const container = new ContainerBuilder();
  if (controls && roles.length > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`stamina:role:${ownerId}`)
          .setPlaceholder(tr("l5_SelectRole"))
          .addOptions(roleSelectOptions(roles, selectedKey)),
      ),
    );
  }
  container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(imageRef)));
  if (text) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (controls) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`stamina:close:${ownerId}`).setLabel(`✖ ${tr("l5_Close")}`).setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return container;
}

async function loadView(
  client: ExtendedClient,
  userId: string,
  accounts: any[],
  role: EndfieldRoleEntry,
  tr: any,
): Promise<{ view: StaminaView } | { error: string }> {
  const account = accounts[role.accountIndex];
  if (account.invalid) await ensureAccountBinding(account, userId, client.db, tr.lang).catch(() => false);
  let res: any;
  try {
    res = await withAutoRefresh(
      client,
      userId,
      account,
      (cred: string, salt: string, options: any) => getCardDetail(role.roleId, role.serverId, role.skUserId, tr.lang, cred, salt, options),
      tr.lang,
    );
  } catch (e: any) {
    if (e?.message === "TokenExpired") return { error: tr("TokenExpired") };
    throw e;
  }
  if (!res || res.code !== 0 || !res.data?.detail) {
    return { error: res?.code === 10000 ? tr("TokenExpired") : `${tr("Error")} (API Code: ${res?.code ?? "NULL"})` };
  }
  const view = buildStaminaView(res.data.detail, Date.now());
  if (!view.hasData) return { error: tr("stamina_NoData") };
  return { view };
}

/** Resolves accounts and roles, refreshing bindings only when no Endfield role is known yet. */
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

async function render(client: ExtendedClient, userId: string, tr: any, selectedKey?: string) {
  const { accounts, roles, error } = await resolveRoles(client, userId, tr);
  if (error) return textPayload(error);
  const role = findRoleByKey(roles, selectedKey) ?? roles[0];
  const result = await loadView(client, userId, accounts, role, tr);
  if ("error" in result) return textPayload(result.error);
  const png = await buildStaminaCard(result.view, tr);
  return {
    files: [new AttachmentBuilder(png, { name: FILE_NAME })],
    attachments: [],
    flags: V2,
    components: [panel(tr, userId, roles, roleKey(role), staminaMessageText(result.view, tr), `attachment://${FILE_NAME}`, true)],
  };
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("stamina")
    .setDescription("Check your Endfield sanity, daily activity and weekly progress")
    .setNameLocalizations({ "zh-TW": "理智" })
    .setDescriptionLocalizations({ "zh-TW": "查看終末地即時理智、回滿時間、每日活躍與週常進度" }) as SlashCommandBuilder,

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    const i = interaction as any;

    // Components of an earlier /stamina reply: stamina:<action>:<ownerId>
    if (i.isStringSelectMenu?.() || i.isButton?.()) {
      const [, action, ownerId] = String(i.customId).split(":");
      if (ownerId !== i.user.id) {
        await i.reply({ content: tr("l5_NotOwner"), flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      if (action === "close") {
        // Keep the card, drop the controls; reuse the already uploaded attachment.
        const existing = i.message?.attachments?.first?.()?.url;
        const container = new ContainerBuilder().addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(existing || `attachment://${FILE_NAME}`)),
        );
        const textDisplay = (i.message?.components?.[0]?.components ?? []).find((c: any) => c?.type === 10 && typeof c.content === "string");
        if (textDisplay) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(textDisplay.content));
        await i.update({ components: [container], flags: V2 });
        return;
      }
      if (action === "role" && i.isStringSelectMenu?.()) {
        await i.deferUpdate();
        await i.editReply(await render(client, i.user.id, tr, i.values?.[0]));
      }
      return;
    }

    if (!i.isChatInputCommand?.()) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral | V2 });
    await i.editReply(await render(client, i.user.id, tr));
  },
};

export default command;
