import {
  MessageFlags,
  ActionRowBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  ButtonInteraction,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import {
  getAccounts,
} from "../../../utils/accountUtils";
import {
  fetchAndMergeGachaLog,
  fetchAndMergeGachaLogFromAccount,
  GachaApiError,
  analyzeGachaImportFingerprint,
} from "../../../utils/gachaLogUtils";
import { GachaContext } from "./context";
import { getAllPossibleUserRoles, findLinkedAccount } from "./accounts";
import { buildProgressHandlers } from "./autoLoad";
import { showGachaStats } from "./view";

export async function doFetchGachaLog(
  ctx: GachaContext,
  url: string,
  selectedUidRaw: string,
  userId: string,
  skipFingerprintCheck: boolean = false,
) {
  const { interaction, tr, db } = ctx;
  const TOKEN_EXPIRED_MESSAGE = tr("gacha_log_token_expired_message");
  const allRoles = await getAllPossibleUserRoles(userId, db);

  let selectedUid = selectedUidRaw;
  let accountIndex: number | undefined = undefined;
  let nickname: string | undefined = undefined;

  if (selectedUid === "CREATE_NEW_GUEST") {
    selectedUid = `EF_GUEST_${userId}_${Date.now()}`;
    nickname = tr("gacha_log_load_NewGuestName");
  } else {
    accountIndex = allRoles.findIndex((r) => r.uid === selectedUid) + 1;
    nickname = allRoles.find((r) => r.uid === selectedUid)?.nickname;
  }

  if (
    !skipFingerprintCheck &&
    !selectedUid.startsWith("EF_GUEST_") &&
    allRoles.length > 1
  ) {
    try {
      const candidateUids = Array.from(new Set(allRoles.map((r) => r.uid)));
      const fingerprint = await analyzeGachaImportFingerprint(
        db,
        url,
        candidateUids,
        selectedUid,
        tr.lang,
      );

      const bestUid = fingerprint.recommendedUid;
      const bestScore = Number(fingerprint.confidence || 0);
      const selectedScore = Number(fingerprint.selectedScore || 0);
      const hasMismatch =
        !!bestUid &&
        bestUid !== selectedUid &&
        bestScore - selectedScore >= 0.08;
      const lowConfidence = bestScore > 0 && bestScore < 0.58;

      if (hasMismatch || lowConfidence) {
        const pendingKey = `PENDING_GACHA_FINGERPRINT_${interaction.user.id}`;
        await db.set(pendingKey, {
          url,
          userId,
          selectedUid,
          predictedUid: bestUid || null,
          confidence: bestScore,
          createdAt: Date.now(),
        });

        const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("gacha:log_load_confirm:keep")
            .setLabel(
              tr("gacha_log_fingerprint_keep_selected", {
                uid: selectedUid,
              }),
            )
            .setStyle(ButtonStyle.Secondary),
          ...(hasMismatch && bestUid
            ? [
                new ButtonBuilder()
                  .setCustomId("gacha:log_load_confirm:switch")
                  .setLabel(
                    tr("gacha_log_fingerprint_switch_predicted", {
                      uid: bestUid,
                    }),
                  )
                  .setStyle(ButtonStyle.Primary),
              ]
            : []),
          new ButtonBuilder()
            .setCustomId("gacha:log_load_confirm:cancel")
            .setLabel(tr("Cancel"))
            .setStyle(ButtonStyle.Danger),
        );

        await interaction.editReply({
          content: tr("gacha_log_fingerprint_prompt", {
            selectedUid,
            predictedUid: bestUid || "N/A",
            confidence: `${(bestScore * 100).toFixed(1)}%`,
          }),
          components: [buttons],
        });
        return;
      }
    } catch (e) {
      console.error(
        "[Gacha Load] Fingerprint check failed, continue import",
        e,
      );
    }
  }

  const { onProgressUpdate, start, stop } = buildProgressHandlers(ctx);

  try {
    await start();

    const mergeResult = await fetchAndMergeGachaLog(
      db,
      url,
      onProgressUpdate,
      selectedUid,
      tr.lang,
      interaction.user.displayAvatarURL({ extension: "png", size: 128 }),
      interaction.user.displayName,
      accountIndex && accountIndex > 0 ? accountIndex : undefined,
      nickname,
    );

    stop();
    await showGachaStats(ctx, selectedUid, "limited_char", "", 0, "", true);

    if (mergeResult.hasDataGap) {
      await interaction.followUp({
        content: tr("gacha_log_load_gap_warning"),
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    stop();
    let errorMessage: string;
    if (error instanceof GachaApiError && error.apiCode === 40100) {
      errorMessage = TOKEN_EXPIRED_MESSAGE;
    } else {
      const err = error as Error;
      errorMessage = err.message || tr("UnknownError");
    }
    await interaction.followUp({
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
  }
}

export async function handleLogHow(
  ctx: GachaContext,
  interaction: ChatInputCommandInteraction,
) {
  const { tr } = ctx;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply({
    content: `${tr("gacha_log_how_Title")}\n\n${tr("gacha_log_how_Steps")}`,
  });
  return;
}

export async function handleLogLoad(
  ctx: GachaContext,
  interaction: ChatInputCommandInteraction,
) {
  const { tr, db } = ctx;

  let selectedUid = interaction.options.getString("account");

  await interaction.deferReply();
  await interaction.editReply({
    content: tr("gacha_log_load_Loading"),
  });

  if (!selectedUid) {
    const allRoles = await getAllPossibleUserRoles(
      interaction.user.id,
      db,
    );
    if (allRoles.length > 0) {
      selectedUid = allRoles[0].uid;
    } else {
      selectedUid = "CREATE_NEW_GUEST";
    }
  }

  const replyError = async (msg: string) => {
    await interaction.deleteReply().catch(() => {});
    await interaction.followUp({
      content: msg,
      flags: MessageFlags.Ephemeral,
    });
  };

  // Auto-sync from linked account
  const userAccounts = await getAccounts(db, interaction.user.id);
  if (!userAccounts?.length) {
    await replyError(tr("gacha_log_load_NoLinkedAccount"));
    return;
  }
  const allRoles = await getAllPossibleUserRoles(
    interaction.user.id,
    db,
  );
  const accountIndex =
    allRoles.findIndex((r) => r.uid === selectedUid) + 1;
  const matchedRole = allRoles.find((r) => r.uid === selectedUid);
  const nickname = matchedRole?.nickname;
  // Use bindingUid (account-level uid) for u8_token_by_uid OAuth exchange,
  // not rawUid (role-level roleId) which is for game API calls.
  const efGameUid = matchedRole?.bindingUid || matchedRole?.rawUid;
  // Find the account that owns this specific game UID
  const linkedAccount = findLinkedAccount(userAccounts, efGameUid);
  if (!linkedAccount || !efGameUid) {
    await replyError(tr("gacha_log_load_NoLinkedAccount"));
    return;
  }
  {
    const { onProgressUpdate, start, stop } = buildProgressHandlers(ctx);
    try {
      await start();
      const mergeResult = await fetchAndMergeGachaLogFromAccount(
        db,
        linkedAccount.cookie,
        efGameUid,
        "gryphline",
        selectedUid,
        onProgressUpdate,
        tr.lang,
        interaction.user.displayAvatarURL({
          extension: "png",
          size: 128,
        }),
        interaction.user.displayName,
        accountIndex > 0 ? accountIndex : undefined,
        nickname,
      );
      stop();
      await showGachaStats(
        ctx,
        selectedUid,
        "limited_char",
        "",
        0,
        "",
        true,
      );
      if (mergeResult.hasDataGap) {
        await interaction.followUp({
          content: tr("gacha_log_load_gap_warning"),
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      stop();
      const errorMessage =
        error instanceof GachaApiError && error.apiCode === 40100
          ? tr("gacha_log_load_LinkedAccountExpired")
          : tr("gacha_log_load_Error", {
              error:
                error instanceof Error ? error.message : String(error),
            });
      await replyError(errorMessage);
    }
  }
  return;
}

export async function handleLoadConfirmButton(
  ctx: GachaContext,
  btnInteraction: ButtonInteraction,
  parts: string[],
) {
  const { tr, db } = ctx;

  const mode = parts[2];
  const pendingKey = `PENDING_GACHA_FINGERPRINT_${btnInteraction.user.id}`;
  const pending = await db.get<any>(pendingKey);

  if (!pending) {
    await btnInteraction.update({
      content: tr("gacha_log_fingerprint_expired"),
      components: [],
    });
    return;
  }

  if (mode === "cancel") {
    await db.delete(pendingKey);
    await btnInteraction.update({
      content: tr("Cancelled"),
      components: [],
    });
    return;
  }

  await btnInteraction.deferUpdate();

  const isExpired =
    Date.now() - Number(pending.createdAt || 0) > 1000 * 60 * 15;
  if (isExpired) {
    await db.delete(pendingKey);
    await btnInteraction.editReply({
      content: tr("gacha_log_fingerprint_expired"),
      components: [],
    });
    return;
  }

  const targetImportUid =
    mode === "switch" && pending.predictedUid
      ? String(pending.predictedUid)
      : String(pending.selectedUid);

  await db.delete(pendingKey);
  await btnInteraction.editReply({
    content: tr("gacha_log_load_Loading"),
    components: [],
  });
  await doFetchGachaLog(
    ctx,
    String(pending.url),
    targetImportUid,
    String(pending.userId || btnInteraction.user.id),
    true,
  );
  return;
}

export async function handleLoadModal(
  ctx: GachaContext,
  interaction: ModalSubmitInteraction,
  parts: string[],
) {
  const { tr, db } = ctx;

  const url = interaction.fields.getTextInputValue("url").trim();
  const userId = interaction.user.id;

  if (parts[2]) {
    // Direct load — uid was encoded in customId (re-entry or from view menu)
    await interaction.deferReply();
    await interaction.editReply({
      content: tr("gacha_log_load_Loading"),
    });

    if (!url) {
      // Empty URL — try auto-sync using linked account
      const userAccounts = await getAccounts(db, userId);
      if (!userAccounts?.length) {
        await interaction.editReply({
          content: tr("gacha_log_load_NoLinkedAccount"),
        });
        return;
      }
      const selectedUid = parts[2];
      const allRoles = await getAllPossibleUserRoles(userId, db);
      const accountIndex =
        allRoles.findIndex((r) => r.uid === selectedUid) + 1;
      const matchedRole2 = allRoles.find((r) => r.uid === selectedUid);
      const nickname = matchedRole2?.nickname;
      const efGameUid2 = matchedRole2?.bindingUid || matchedRole2?.rawUid;
      if (!efGameUid2) {
        await interaction.editReply({
          content: tr("gacha_log_load_NoLinkedAccount"),
        });
        return;
      }
      // Find the account that owns this specific game UID
      const linkedAccount = findLinkedAccount(userAccounts, efGameUid2);
      if (!linkedAccount) {
        await interaction.editReply({
          content: tr("gacha_log_load_NoLinkedAccount"),
        });
        return;
      }
      {
        const { onProgressUpdate, start, stop } = buildProgressHandlers(ctx);
        try {
          await start();
          const mergeResult = await fetchAndMergeGachaLogFromAccount(
            db,
            linkedAccount.cookie,
            efGameUid2,
            "gryphline",
            selectedUid,
            onProgressUpdate,
            tr.lang,
            interaction.user.displayAvatarURL({
              extension: "png",
              size: 128,
            }),
            interaction.user.displayName,
            accountIndex > 0 ? accountIndex : undefined,
            nickname,
          );
          stop();
          await showGachaStats(
            ctx,
            selectedUid,
            "limited_char",
            "",
            0,
            "",
            true,
          );
          if (mergeResult.hasDataGap) {
            await interaction.followUp({
              content: tr("gacha_log_load_gap_warning"),
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch (error) {
          stop();
          const errorMessage =
            error instanceof GachaApiError && error.apiCode === 40100
              ? tr("gacha_log_load_LinkedAccountExpired")
              : tr("gacha_log_load_Error", {
                  error:
                    error instanceof Error
                      ? error.message
                      : String(error),
                });
          await interaction.editReply({ content: errorMessage });
        }
      }
      return;
    }

    await doFetchGachaLog(ctx, url, parts[2], userId);
    return;
  }

  // Regular flow — store URL and show account selection
  if (!url) {
    await interaction.reply({
      content: tr("gacha_log_load_NoLinkedAccount"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const allRoles = await getAllPossibleUserRoles(userId, db);

  await db.set(`PENDING_GACHA_URL_${userId}`, url);

  // Deduplicate by rawUid — prefer the uid that already has gacha log data
  const seenRawUids = new Map<string, string>(); // rawUid -> selected uid
  for (const r of allRoles) {
    if (!seenRawUids.has(r.rawUid)) {
      seenRawUids.set(r.rawUid, r.uid);
    } else {
      const existing = seenRawUids.get(r.rawUid)!;
      const existingHasData =
        (await db.get(`GACHA_LOG_${existing}`)) != null;
      if (!existingHasData) {
        const thisHasData = (await db.get(`GACHA_LOG_${r.uid}`)) != null;
        if (thisHasData) seenRawUids.set(r.rawUid, r.uid);
      }
    }
  }
  const roleMap = new Map(allRoles.map((r) => [r.uid, r]));
  const options = [...seenRawUids.values()].map((uid) => {
    const r = roleMap.get(uid)!;
    return { label: `${r.nickname} (${r.uid})`, value: r.uid };
  });

  options.push({
    label: tr("gacha_log_load_CreateNewGuest"),
    value: "CREATE_NEW_GUEST",
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId("gacha:log_load_select_target")
    .setPlaceholder(tr("gacha_log_view_SelectPool"))
    .addOptions(options);

  const row =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

  await interaction.reply({
    content: tr("gacha_log_load_SelectAccount", {
      user: interaction.user.toString(),
    }),
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
  return;
}
