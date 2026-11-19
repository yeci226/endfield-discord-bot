import {
  MessageFlags,
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
import { handleGachaLeaderboardComponent } from "./leaderboard";
import { doFetchGachaLog } from "./load";
import { handleLoadConfirmButton, handleLoadModal } from "./load";
import {
  handleClearConfirmButton,
  handleClearCancelButton,
  handleRecoverButton,
  handleMigrateSelect,
} from "./maintenance";
import { handleSimPullButton } from "./simulate";
import { pendingUrlKey, readPending } from "./pending";

export type ComponentOperator = {
  /** The user who clicked. */
  clickerId: string;
  /** Who ran the command that produced the message (Discord's own record). */
  messageInvokerId?: string | null;
  /** An invoker id carried in the customId (only on ids built since this check existed). */
  embeddedInvokerId?: string | null;
  /** Ephemeral messages are only ever shown to their invoker. */
  ephemeral?: boolean;
};

/**
 * May this click change the message / act on the stored state?
 * Only the user who invoked the command. The customId's UID or user id are
 * never proof on their own; Discord's record of who the message was
 * answering is.
 */
export function mayOperateGachaComponent(op: ComponentOperator): boolean {
  if (op.embeddedInvokerId && op.embeddedInvokerId !== op.clickerId) {
    return false;
  }
  if (op.messageInvokerId) return op.messageInvokerId === op.clickerId;
  // No record on an old message: an embedded id that matched is enough,
  // otherwise only an ephemeral message (visible to its invoker alone) is safe.
  if (op.embeddedInvokerId) return true;
  return !!op.ephemeral;
}

/** The invoker Discord recorded on a message (new metadata first, legacy field second). */
export function getMessageInvokerId(message: any): string | null {
  const id = message?.interactionMetadata?.user?.id ?? message?.interaction?.user?.id;
  return id ? String(id) : null;
}

/** The invoker id a customId carries, for the actions that carry one. */
export function getEmbeddedInvokerId(parts: string[]): string | null {
  const pick = (v: string | undefined) =>
    v && /^\d{15,25}$/.test(v) ? v : null;
  if (parts[1] === "sim_pull") return pick(parts[2]);
  if (parts[1] === "log_load_confirm") return pick(parts[3]);
  // gacha:lb_<action>:<pool>:<sort>:<scope>:<page>:<invoker>. Ids posted before
  // the invoker was appended have no 7th part and fall back to Discord's record.
  if (parts[1]?.startsWith("lb_")) return pick(parts[6]);
  return null;
}

/** Gate for every gacha button / select. Replies (ephemeral) and returns false when refused. */
async function allowClicker(
  ctx: GachaContext,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  parts: string[],
): Promise<boolean> {
  const message: any = interaction.message;
  const ok = mayOperateGachaComponent({
    clickerId: interaction.user.id,
    messageInvokerId: getMessageInvokerId(message),
    embeddedInvokerId: getEmbeddedInvokerId(parts),
    ephemeral: !!message?.flags?.has?.(MessageFlags.Ephemeral),
  });
  if (ok) return true;
  await interaction
    .reply({
      content: ctx.tr("gacha_component_not_yours"),
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => {});
  return false;
}

export async function handleGachaSelectMenu(
  ctx: GachaContext,
  interaction: StringSelectMenuInteraction,
) {
  const { tr, db } = ctx;

  const customId = interaction.customId;
  const parts = customId.split(":");
  const action = parts[1];
  const targetUid = parts[2];

  if (!(await allowClicker(ctx, interaction, parts))) return;

  if (action?.startsWith("lb_")) {
    if (await handleGachaLeaderboardComponent(ctx, interaction)) return;
  }

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
  } else if (action === "log_load_select_target") {
    const selectedUidRaw = interaction.values[0];
    const userId = interaction.user.id;
    const pendingKey = pendingUrlKey(userId);
    const pendingUrl = (await readPending<{ url: string }>(db, pendingKey))
      ?.url;

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
    await db.delete(pendingKey);
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

  if (!(await allowClicker(ctx, btnInteraction, parts))) return;

  if (action?.startsWith("lb_")) {
    if (await handleGachaLeaderboardComponent(ctx, btnInteraction)) return;
  }

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
