import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  ButtonInteraction,
} from "discord.js";
import {
  GachaType,
} from "../../../utils/gachaCanvasUtils";
import { GachaContext } from "./context";
import { showGachaStats } from "./view";
import { showGachaLeaderboard } from "./leaderboard";
import { doFetchGachaLog } from "./load";
import { handleLoadConfirmButton, handleLoadModal } from "./load";
import {
  handleClearConfirmButton,
  handleClearCancelButton,
  handleRecoverButton,
  handleMigrateSelect,
} from "./maintenance";
import { handleSimPullButton } from "./simulate";

export async function handleGachaSelectMenu(
  ctx: GachaContext,
  interaction: StringSelectMenuInteraction,
) {
  const { tr, db } = ctx;

  const customId = interaction.customId;
  const parts = customId.split(":");
  const action = parts[1];
  const targetUid = parts[2];

  if (action === "log_type") {
    await interaction.deferUpdate();
    const selectedType = interaction.values[0] as GachaType;
    // Always reset to overview when changing pool type (the old pool belongs to a different type)
    await showGachaStats(ctx, targetUid, selectedType, undefined, 0);
    return;
  } else if (action === "log_pool") {
    await interaction.deferUpdate();
    const poolId = interaction.values[0];
    const currentType = parts[3] as GachaType;
    await showGachaStats(
      ctx,
      targetUid,
      currentType,
      poolId === "all" ? undefined : poolId,
      0,
    );
    return;
  } else if (action === "log_load_menu") {
    const selectedUid = interaction.values[0];
    const modal = new ModalBuilder()
      .setCustomId(`gacha:log_load:${selectedUid}`)
      .setTitle(tr("gacha_log_load_ModalTitle"));

    const urlInput = new TextInputBuilder()
      .setCustomId("url")
      .setLabel(tr("gacha_log_load_UrlLabel"))
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder(tr("gacha_log_load_UrlPlaceholder"))
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(urlInput),
    );

    await interaction.showModal(modal);
    return;
  } else if (
    action === "lb_type" ||
    action === "lb_pool" ||
    action === "lb_subpool" ||
    action === "lb_sort"
  ) {
    await interaction.deferUpdate();
    const currentPool = parts[2];
    const currentSort = parts[3] as "pulls" | "luck";

    let newPool = currentPool;
    let newSort = currentSort;

    if (action === "lb_pool" || action === "lb_subpool")
      newPool = interaction.values[0];
    if (action === "lb_sort")
      newSort = interaction.values[0] as "pulls" | "luck";

    await showGachaLeaderboard(ctx, newPool, newSort);
    return;
  } else if (action === "log_load_select_target") {
    const selectedUidRaw = interaction.values[0];
    const userId = interaction.user.id;
    const pendingUrl = await db.get<string>(`PENDING_GACHA_URL_${userId}`);

    if (!pendingUrl) {
      // URL expired or missing — show URL input modal again with uid in customId
      const modal = new ModalBuilder()
        .setCustomId(`gacha:log_load:${selectedUidRaw}`)
        .setTitle(tr("gacha_log_load_ModalTitle"));

      const urlInput = new TextInputBuilder()
        .setCustomId("url")
        .setLabel(tr("gacha_log_load_UrlLabel"))
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("https://ef-webview.gryphline.com/...")
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(urlInput),
      );

      await interaction.showModal(modal);
      return;
    }

    await interaction.deferUpdate();
    await db.delete(`PENDING_GACHA_URL_${userId}`);
    await doFetchGachaLog(ctx, pendingUrl, selectedUidRaw, userId);
    return;
  }

  if (parts[1] === "log_migrate_select") {
    await handleMigrateSelect(ctx, interaction, parts);
    return;
  }
}

export async function handleGachaButton(
  ctx: GachaContext,
  interaction: ButtonInteraction,
) {
  const btnInteraction = interaction as ButtonInteraction;
  const customId = btnInteraction.customId;
  const parts = customId.split(":");
  const action = parts[1];
  const targetUid = parts[2];

  if (action === "log_page") {
    await btnInteraction.deferUpdate();
    const pageType = parts[3] as GachaType;
    const poolId = parts[4];
    const gotoPage = parseInt(parts[5], 10);
    await showGachaStats(ctx, targetUid, pageType, poolId, gotoPage);
    return;
  }

  if (action === "log_load_confirm") {
    await handleLoadConfirmButton(ctx, btnInteraction, parts);
    return;
  }

  if (action === "log_clear_confirm") {
    await handleClearConfirmButton(ctx, btnInteraction, parts);
    return;
  }

  if (action === "log_clear_cancel") {
    await handleClearCancelButton(ctx, btnInteraction);
    return;
  }

  if (action === "log_recover") {
    await handleRecoverButton(ctx, btnInteraction, parts);
    return;
  }

  if (action === "sim_pull") {
    await handleSimPullButton(ctx, btnInteraction, parts);
    return;
  }
}

export async function handleGachaModal(
  ctx: GachaContext,
  interaction: ModalSubmitInteraction,
) {
  const parts = interaction.customId.split(":");
  if (parts[1] === "log_load") {
    await handleLoadModal(ctx, interaction, parts);
  }
}
