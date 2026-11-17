import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, StringSelectMenuBuilder } from "discord.js";
import type { ExtendedClient } from "../structures/Client";
import type { CardDetail } from "./skportApi";
import { getCardDetail } from "./skportApi";
import { getAccounts, normalizeBindingEntries, withAutoRefresh } from "./accountUtils";
import { drawDashboard, drawCharacterDetail } from "./canvasUtils";
import { ProfileTemplateService } from "../services/ProfileTemplateService";
import { EnumService } from "../services/EnumService";
import { drawPlayerCard, layoutPlayerCards, moduleVisible, playerText, profileSections, publicProfileDetail } from "./playerCards";

export interface ProfileTarget { ownerId: string; uid: string; roleId: string; serverId: string }
export function findProfileAccount(accounts: any[], target: ProfileTarget): any | undefined {
  return accounts.find((account) => String(account.info?.id ?? account.info?.uid) === target.uid && normalizeBindingEntries(account.roles).some((binding) =>
    (binding.roles || (binding.defaultRole ? [binding.defaultRole] : [])).some((role: any) => String(role.roleId) === target.roleId && String(role.serverId) === target.serverId)));
}

export async function profilePayload(client: ExtendedClient, target: ProfileTarget, detail: CardDetail, tr: any, page = 1, index = 0, charId?: string, account?: any, sheet = 0): Promise<any> {
  const t = (tw: string, en: string) => playerText(tr.lang, tw, en);
  const suffix = `${target.roleId}:${target.serverId}:${target.uid}:${target.ownerId}`;
  const id = (action: string) => `profile:${action}:${suffix}`;
  const safe = publicProfileDetail(detail);
  let image: Buffer;
  let sheetCount = 1;
  if (charId) {
    const charIndex = safe.chars.findIndex((c) => c.id === charId);
    if (charIndex < 0) throw new Error(t("幹員不存在或未公開", "Operator unavailable or private"));
    const enums = await EnumService.getEnumsCached(client.db, account?.cred, tr.lang, account?.salt);
    image = await drawCharacterDetail(safe.chars[charIndex], tr, safe, [...(enums?.equipProperties || []), ...(enums?.equipAbilities || [])], charIndex + 1);
  } else if (page === 1) {
    const template = await ProfileTemplateService.getUserTemplate(client.db, target.ownerId);
    image = await drawDashboard(safe, tr, template);
  } else {
    const count = page === 2 ? safe.domain?.length || 1 : Math.ceil((safe.achieve?.achieveMedals?.length || 0) / 12) || 1;
    index = Math.min(Math.max(0, index), count - 1);
    const template = await ProfileTemplateService.getUserTemplate(client.db, target.ownerId);
    const sections = profileSections(safe, page, tr.lang, index, index);
    sheetCount = layoutPlayerCards(sections).length;
    sheet = Math.min(Math.max(0, sheet), sheetCount - 1);
    image = await drawPlayerCard(safe, page === 2 ? `${t("建設與探索", "Development & exploration")} · ${safe.domain?.[index]?.name || "—"}` : page === 3 ? t("進度與勳章", "Progress & medals") : t("勳章收藏", "Medal collection"), sections, tr.lang, Date.now(), template, sheet);
  }
  const fileName = page === 1 || charId ? "profile.png" : "profile.webp";
  const container = new ContainerBuilder().addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${fileName}`)));
  container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...[t("1 · 基本資訊", "1 · Overview"), t("2 · 建設探索", "2 · Development"), t("3 · 進度勳章", "3 · Progress")].map((label, i) => new ButtonBuilder().setCustomId(id(`page${i + 1}`)).setLabel(label).setStyle(page === i + 1 && !charId ? ButtonStyle.Primary : ButtonStyle.Secondary)),
  ));
  if (page === 1 && safe.chars.length) {
    container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(id("char_select")).setPlaceholder(t("查看幹員", "View operator"))
      .addOptions(safe.chars.slice(0, 25).map((char) => ({ label: (char.charData?.name || char.id).slice(0, 100), value: char.id, default: char.id === charId })))));
  }
  if (page === 2 && safe.domain?.length && (moduleVisible(detail, "MODULE_DOMAIN_BUILD") || moduleVisible(detail, "MODULE_DOMAIN_EXPLORE"))) {
    container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(id("domain")).setPlaceholder(t("選擇地區", "Choose region"))
      .addOptions(safe.domain!.slice(0, 25).map((domain, i) => ({ label: (domain.name || domain.domainId).slice(0, 100), value: String(i), default: i === index })))));
  }
  if (sheetCount > 1) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id(`sheet${page}_${index}_${sheet - 1}`)).setLabel(t("上一張", "Previous image")).setStyle(ButtonStyle.Secondary).setDisabled(sheet === 0),
    new ButtonBuilder().setCustomId(id(`sheet${page}_${index}_${sheet + 1}`)).setLabel(t(`下一張 · ${sheet + 1}/${sheetCount}`, `Next image · ${sheet + 1}/${sheetCount}`)).setStyle(ButtonStyle.Secondary).setDisabled(sheet === sheetCount - 1),
  ));
  if (page === 3 && moduleVisible(detail, "MODULE_ACHIEVE")) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(id("medals0")).setLabel(t("查看完整勳章", "View all medals")).setStyle(ButtonStyle.Secondary)));
  if (page === 4) {
    const max = Math.max(0, Math.ceil((safe.achieve?.achieveMedals?.length || 0) / 12) - 1);
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(id(`medals${index - 1}`)).setLabel(t("上一頁勳章", "Previous medals")).setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
      new ButtonBuilder().setCustomId(id(`medals${index + 1}`)).setLabel(t("下一頁勳章", "Next medals")).setStyle(ButtonStyle.Secondary).setDisabled(index >= max),
    ));
  }
  return { attachments: [], files: [new AttachmentBuilder(image, { name: fileName })], flags: MessageFlags.IsComponentsV2, components: [container] };
}

export function profileNavigation(action: string, value?: string): { page: number; index: number; sheet: number } {
  const match = /^sheet([234])_(\d+)_(\d+)$/.exec(action);
  if (match) {
    const [page, index, sheet] = match.slice(1).map(Number);
    if (![index, sheet].every(Number.isSafeInteger)) throw new Error("Invalid profile page");
    return { page, index, sheet };
  }
  const page = action === "domain" ? 2 : /^medals\d+$/.test(action) ? 4 : /^page[123]$/.test(action) ? Number(action.slice(4)) : action === "char_select" ? 1 : 0;
  const index = action === "domain" ? Number(value) : page === 4 ? Number(action.slice(6)) : 0;
  if (!page || !Number.isSafeInteger(index) || index < 0) throw new Error("Invalid profile page");
  return { page, index, sheet: 0 };
}

export async function handleProfilePage(client: ExtendedClient, interaction: any, tr: any): Promise<void> {
  const [, action, roleId, serverId, uid, ownerId] = interaction.customId.split(":");
  const target = { roleId, serverId, uid, ownerId: ownerId || interaction.user.id };
  try {
    const account = findProfileAccount(await getAccounts(client.db, target.ownerId), target);
    if (!account) throw new Error(playerText(tr.lang, "帳號或角色已變更，請重新查詢名片。", "Account or role changed. Run /profile again."));
    const response = await withAutoRefresh(client, target.ownerId, account, (cred, salt, options) => getCardDetail(roleId, serverId, uid, tr.lang, cred, salt, options), tr.lang);
    if (response?.code !== 0 || !response?.data?.detail) throw new Error(tr("TokenExpired"));
    const { page, index, sheet } = profileNavigation(action, interaction.values?.[0]);
    const charId = action === "char_select" && interaction.values[0] !== "home" ? interaction.values[0] : undefined;
    const payload = await profilePayload(client, target, response.data.detail, tr, page, index, charId, account, sheet);
    await interaction.editReply(payload);
  } catch (error: any) {
    await interaction.followUp({ content: String(error.message).slice(0, 1900), flags: MessageFlags.Ephemeral });
  }
}
