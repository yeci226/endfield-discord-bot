import {
  MessageFlags,
  ActionRowBuilder,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { getAccounts } from "../../../utils/accountUtils";
import {
  ENDFIELD_GAME_ID,
  getPrimaryBindingRoleForGame,
} from "../../../utils/bindingRoles";
import {
  clearGachaLog,
  migrateGachaLog,
} from "../../../utils/gachaLogUtils";
import { GachaContext } from "./context";
import {
  getAllPossibleUserRoles,
  getOwnedGachaUids,
  isOwnGuestUid,
  resolveOwnedGachaUid,
} from "./accounts";

/** Legacy shared bucket of logs saved before the UID was known. */
export const RECOVERY_SOURCE_UID = "EF_undefined";

/** Range values travel in a customId split on ":", so colons are escaped. */
function decodeRangePart(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export async function handleLogClear(
  ctx: GachaContext,
  interaction: ChatInputCommandInteraction,
) {
  const { tr, db } = ctx;

  const targetUidOption = interaction.options.getString("account");
  const startTime = interaction.options.getString("start_time");
  const endTime = interaction.options.getString("end_time");

  const owned = await getOwnedGachaUids(db, interaction.user.id);

  let targetUid = targetUidOption;
  if (targetUid) {
    const resolved = resolveOwnedGachaUid(targetUid, owned);
    if (!resolved.ok) {
      await interaction.reply({
        content: tr("gacha_uid_not_owned"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    targetUid = resolved.uid;
  } else {
    const accounts = await getAccounts(db, interaction.user.id);
    const efRole = getPrimaryBindingRoleForGame(
      accounts?.[0]?.roles,
      ENDFIELD_GAME_ID,
    );
    const gameUid = efRole?.roleId || efRole?.bindingUid;
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
      `gacha:log_clear_confirm:${targetUid}:${encodeURIComponent(startTime || "")}:${encodeURIComponent(endTime || "")}`,
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

  const targetUid = parts[2];
  const startTime = decodeRangePart(parts[3]);
  const endTime = decodeRangePart(parts[4]);

  // The UID in the customId proves nothing: check it against the clicker.
  const owned = await getOwnedGachaUids(db, btnInteraction.user.id);
  if (!resolveOwnedGachaUid(targetUid, owned).ok) {
    await btnInteraction.update({
      content: tr("gacha_uid_not_owned"),
      components: [],
    });
    return;
  }

  await btnInteraction.deferUpdate();
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

  const targetUid = parts[2];
  const sourceUid = RECOVERY_SOURCE_UID;

  const owned = await getOwnedGachaUids(db, btnInteraction.user.id);
  if (!resolveOwnedGachaUid(targetUid, owned).ok) {
    await btnInteraction.update({
      content: tr("gacha_uid_not_owned"),
      components: [],
    });
    return;
  }

  await btnInteraction.deferUpdate();

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

  // Source: one of the clicker's own guest logs (or the legacy shared bucket);
  // target: one of the clicker's own UIDs. Neither may rest on the customId alone.
  const owned = await getOwnedGachaUids(db, interaction.user.id);
  if (
    !(
      sourceUid === RECOVERY_SOURCE_UID ||
      isOwnGuestUid(sourceUid, interaction.user.id)
    ) ||
    !resolveOwnedGachaUid(targetUid, owned).ok
  ) {
    await interaction.editReply({ content: tr("gacha_uid_not_owned") });
    return;
  }

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
