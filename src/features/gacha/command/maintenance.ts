import {
  MessageFlags,
  ActionRowBuilder,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import {
  getAccounts,
  getPrimaryBindingRole,
} from "../../../utils/accountUtils";
import {
  clearGachaLog,
  migrateGachaLog,
} from "../../../utils/gachaLogUtils";
import { GachaContext } from "./context";
import { getAllPossibleUserRoles } from "./accounts";

export async function handleLogClear(
  ctx: GachaContext,
  interaction: ChatInputCommandInteraction,
) {
  const { tr, db } = ctx;

  const targetUidOption = interaction.options.getString("account");
  const startTime = interaction.options.getString("start_time");
  const endTime = interaction.options.getString("end_time");

  let targetUid = targetUidOption;
  if (!targetUid) {
    const accounts = await getAccounts(db, interaction.user.id);
    const primaryBinding = getPrimaryBindingRole(accounts?.[0]?.roles);
    const firstRole = primaryBinding?.role;
    const firstBinding = primaryBinding?.binding;
    const gameUid = firstRole?.roleId || firstBinding?.uid;
    if (gameUid) targetUid = `EF_${gameUid}`;
  }

  if (!targetUid) {
    await interaction.reply({
      content: tr("daily_RoleNotFound"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const confirmBtn = new ButtonBuilder()
    .setCustomId(
      `gacha:log_clear_confirm:${targetUid}:${startTime || ""}:${endTime || ""}`,
    )
    .setLabel(tr("Confirm"))
    .setStyle(ButtonStyle.Danger);

  const cancelBtn = new ButtonBuilder()
    .setCustomId("gacha:log_clear_cancel")
    .setLabel(tr("Cancel"))
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    confirmBtn,
    cancelBtn,
  );

  let rangeMsg = tr("gacha_log_clear_ConfirmAll");
  if (startTime || endTime) {
    rangeMsg = tr("gacha_log_clear_ConfirmRange", {
      start: startTime || "...",
      end: endTime || "...",
    });
  }

  await interaction.reply({
    content: `${tr("gacha_log_clear_Warning", { uid: targetUid })}\n\n${rangeMsg}`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
  return;
}

export async function handleClearConfirmButton(
  ctx: GachaContext,
  btnInteraction: ButtonInteraction,
  parts: string[],
) {
  const { tr, db } = ctx;

  await btnInteraction.deferUpdate();
  const targetUid = parts[2];
  const startTime = parts[3];
  const endTime = parts[4];

  await clearGachaLog(db, targetUid, startTime, endTime);

  await btnInteraction.editReply({
    content: tr("gacha_log_clear_Success", { uid: targetUid }),
    components: [],
  });
  return;
}

export async function handleClearCancelButton(
  ctx: GachaContext,
  btnInteraction: ButtonInteraction,
) {
  const { tr } = ctx;

  await btnInteraction.update({
    content: tr("Cancelled"),
    components: [],
  });
  return;
}

export async function handleRecoverButton(
  ctx: GachaContext,
  btnInteraction: ButtonInteraction,
  parts: string[],
) {
  const { interaction, tr, db } = ctx;

  await btnInteraction.deferUpdate();
  const targetUid = parts[2];
  const sourceUid = "EF_undefined";

  // Fetch accounts again to calculate index
  const allRoles = await getAllPossibleUserRoles(interaction.user.id, db);
  const accountIndex = allRoles.findIndex((r) => r.uid === targetUid) + 1;

  const migrated = await migrateGachaLog(
    db,
    sourceUid,
    targetUid,
    interaction.user.displayName,
    accountIndex > 0 ? accountIndex : 1,
    allRoles.find((r) => r.uid === targetUid)?.nickname,
  );

  if (migrated) {
    const targetRole = allRoles.find((r) => r.uid === targetUid);
    const targetNickname = targetRole?.nickname || "Unknown";
    await interaction.editReply({
      content: tr("gacha_log_recover_Success", {
        nickname: targetNickname,
      }),
      components: [],
    });
  } else {
    await interaction.editReply({
      content: tr("UnknownError"),
      components: [],
    });
  }
  return;
}

export async function handleMigrateSelect(
  ctx: GachaContext,
  interaction: StringSelectMenuInteraction,
  parts: string[],
) {
  const { tr, db } = ctx;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sourceUid = parts[2];
  const targetUid = interaction.values[0];

  // Fetch accounts again to calculate index
  const allRoles = await getAllPossibleUserRoles(interaction.user.id, db);
  const accountIndex = allRoles.findIndex((r) => r.uid === targetUid) + 1;

  const migrated = await migrateGachaLog(
    db,
    sourceUid,
    targetUid,
    interaction.user.displayName,
    accountIndex > 0 ? accountIndex : 1,
    allRoles.find((r) => r.uid === targetUid)?.nickname,
  );

  if (migrated) {
    const targetRole = allRoles.find((r) => r.uid === targetUid);
    const targetNickname = targetRole?.nickname || "Unknown";
    await interaction.editReply({
      content: tr("gacha_log_migrate_Success", {
        nickname: targetNickname,
        uid: targetUid,
      }),
    });
  } else {
    await interaction.editReply({
      content: tr("UnknownError"),
    });
  }
  return;
}
