import {
  MessageFlags,
  ActionRowBuilder,
  ChatInputCommandInteraction,
  AttachmentBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import {
  getAccounts,
} from "../../../utils/accountUtils";
import {
  getGachaStats,
  GachaLogData,
  migrateGachaLog,
  updateLeaderboard,
} from "../../../utils/gachaLogUtils";
import {
  drawGachaStats,
  GachaType,
  getDetailedPageCount,
} from "../../../utils/gachaCanvasUtils";
import moment from "moment";
import {
  getGachaPityGroupId,
  isGachaPoolInCategory,
  paginateGachaOverviewPools,
} from "../../../utils/gachaPoolUtils";
import { GachaContext } from "./context";
import { getAllPossibleUserRoles } from "./accounts";
import { tryAutoLoadGachaLog } from "./autoLoad";

export async function showGachaStats(
  ctx: GachaContext,
  targetUid: string,
  pageType: GachaType,
  poolId: string = "",
  page: number = 0,
  customContent: string | null = null,
  skipAutoLoad: boolean = false,
) {
  const { interaction, tr, db } = ctx;
  const dbKey = `GACHA_LOG_${targetUid}`;
  const data = await db.get<GachaLogData>(dbKey);

  if (!data) {
    if (!skipAutoLoad) {
      const loaded = await tryAutoLoadGachaLog(ctx, targetUid);
      if (loaded) {
        await showGachaStats(
          ctx,
          targetUid,
          pageType,
          poolId,
          page,
          customContent,
          true,
        );
        return;
      }
    }
    await interaction.editReply({
      content: tr("gacha_log_NoData", {
        user: `<@${interaction.user.id}>`,
      }),
    });
    return;
  }

  const stats = await getGachaStats(db, data);

  // Auto-correct pageType based on poolId if a specific pool is selected
  if (poolId && poolId !== "all") {
    const isWeapon = stats.weapon.pools.some((p: any) => p.id === poolId);
    if (isWeapon) {
      pageType = "weapon";
    } else {
      const charPool = stats.char.pools.find((p: any) => p.id === poolId);
      if (charPool) {
        if (charPool.type?.includes("Rerun")) pageType = "rerun_char";
        else if (charPool.type?.includes("Beginner"))
          pageType = "beginner_char";
        else if (
          charPool.type?.includes("Standard") ||
          charPool.type?.includes("Classic")
        )
          pageType = "standard_char";
        else pageType = "limited_char";
      }
    }
  }

  const rawUid = targetUid.replace("EF_CN_", "").replace("EF_", "");

  const allPossibleRoles = await getAllPossibleUserRoles(
    interaction.user.id,
    db,
  );
  const found = allPossibleRoles.find((r) => r.uid === targetUid);

  if (
    !data.info.nickname ||
    data.info.nickname === targetUid ||
    data.info.nickname === rawUid ||
    data.info.nickname === "Unknown"
  ) {
    if (found) {
      data.info.nickname = found.nickname;
      await db.set(`GACHA_LOG_${targetUid}`, data);
    } else if (targetUid.startsWith("EF_GUEST_")) {
      data.info.nickname = "Guest";
    }
  }

  // Always sync leaderboard to ensure any outdated display names or nicknames are fixed
  try {
    const accountIndex =
      allPossibleRoles.findIndex((r) => r.uid === targetUid) + 1;
    await updateLeaderboard(
      db,
      targetUid,
      data,
      interaction.user.displayName,
      accountIndex > 0 ? accountIndex : undefined,
      found?.nickname || data.info.nickname,
    );
  } catch (e) {
    console.error(`[Leaderboard] Sync failed for ${targetUid}:`, e);
  }

  // Filter pools based on current category
  const targetStats = pageType === "weapon" ? stats.weapon : stats.char;
  const filteredPools = targetStats.pools.filter((p: any) =>
    isGachaPoolInCategory(p, pageType),
  );

  const poolRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`gacha:log_pool:${targetUid}:${pageType}`)
        .setPlaceholder(tr("gacha_log_view_SelectPool"))
        .addOptions([
          {
            label: tr("gacha_log_view_Overview"),
            value: "all",
            default: !poolId,
          },
          ...filteredPools.slice(0, 24).map((p) => {
            let description = undefined;
            if (p.startTs && p.endTs) {
              const formatTs = (ts: string) => {
                const tsNum = Number(ts);
                return moment(isNaN(tsNum) ? ts : tsNum).format(
                  "YYYY/MM/DD HH:mm",
                );
              };
              const s = formatTs(p.startTs);
              const e = formatTs(p.endTs);
              description = s === e ? s : `${s} ~ ${e}`;
            }
            return {
              label:
                p.name.length > 100 ? p.name.slice(0, 97) + "..." : p.name,
              value: p.id,
              description,
              default: p.id === poolId,
            };
          }),
        ]),
    );

  const typeRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`gacha:log_type:${targetUid}:${poolId || "all"}`)
        .setPlaceholder(tr("gacha_log_stats_SelectPool"))
        .addOptions([
          {
            label: tr("gacha_log_stats_LimitedCharPool"),
            value: "limited_char",
            default: pageType === "limited_char",
          },
          {
            label: tr("gacha_log_stats_RerunCharPool"),
            value: "rerun_char",
            default: pageType === "rerun_char",
          },

          {
            label: tr("gacha_log_stats_WeaponPool"),
            value: "weapon",
            default: pageType === "weapon",
          },
          {
            label: tr("gacha_log_stats_StandardCharPool"),
            value: "standard_char",
            default: pageType === "standard_char",
          },
          {
            label: tr("gacha_log_stats_BeginnerCharPool"),
            value: "beginner_char",
            default: pageType === "beginner_char",
          },
        ]),
    );

  const image = await drawGachaStats(
    data,
    stats,
    tr,
    pageType as any,
    poolId === "all" ? undefined : poolId,
    page,
    db,
  );
  const attachment = new AttachmentBuilder(image, {
    name: "gacha_stats.webp",
  });

  // Build pagination buttons for overview and detailed modes
  const components: any[] = [poolRow, typeRow];
  if (!poolId || poolId === "all") {
    const overview = paginateGachaOverviewPools(
      targetStats.pools,
      pageType,
      page,
    );
    if (overview.totalPages > 1) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(
              `gacha:log_page:${targetUid}:${pageType}:all:${Math.max(0, overview.page - 1)}`,
            )
            .setLabel("◀")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(overview.page === 0),
          new ButtonBuilder()
            .setCustomId(
              `gacha:log_page_info:${targetUid}:${pageType}:all:${overview.page}`,
            )
            .setLabel(`${overview.page + 1} / ${overview.totalPages}`)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(
              `gacha:log_page:${targetUid}:${pageType}:all:${Math.min(overview.totalPages - 1, overview.page + 1)}`,
            )
            .setLabel("▶")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(overview.page >= overview.totalPages - 1),
        ),
      );
    }
  } else {
    const targetStats = pageType === "weapon" ? stats.weapon : stats.char;
    const pool = targetStats.pools.find((p: any) => p.id === poolId);
    const gId = getGachaPityGroupId(
      pool || {
        id: poolId,
        type: pageType === "weapon" ? "WeaponPool" : "",
      },
    );
    const gSummary = targetStats.summary;
    const pityData = gSummary[gId];
    const isBeginner = gId === "Beginner";
    const newestPoolId =
      pageType === "rerun_char"
        ? targetStats.pools.find((p: any) => p.type?.includes("Rerun"))?.id
        : targetStats.pools[0]?.id;
    const hasPlaceholder = isBeginner
      ? !targetStats.history.some(
          (it: any) => it.poolId === poolId && it.rarity >= 6,
        )
      : gId?.includes("Standard") || poolId === newestPoolId;
    const allPoolItems = targetStats.history.filter(
      (it: any) => it.poolId === poolId && it.rarity >= 4,
    );

    const poolItemsAll = targetStats.history.filter(
      (r: any) => r.poolId === poolId,
    );
    let initialPaddedCount = 0;
    if (poolItemsAll.length > 0) {
      const oldest = poolItemsAll[poolItemsAll.length - 1];
      initialPaddedCount = Math.max(
        0,
        oldest.pitySixCount - oldest.poolTotalCount,
      );
    } else {
      const poolTotal = (pityData as any)?.poolTotalMap?.[poolId] || 0;
      if (poolId === newestPoolId) {
        initialPaddedCount = Math.max(
          0,
          (pityData?.currentPity || 0) - poolTotal,
        );
      }
    }

    const totalPages = getDetailedPageCount(
      allPoolItems,
      hasPlaceholder,
      initialPaddedCount > 0,
    );

    if (totalPages > 1) {
      const pageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `gacha:log_page:${targetUid}:${pageType}:${poolId}:${Math.max(0, page - 1)}`,
          )
          .setLabel("◀")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(
            // Use a different prefix to avoid collision with prev/next buttons
            `gacha:log_page_info:${targetUid}:${pageType}:${poolId}:${page}`,
          )
          .setLabel(`${page + 1} / ${totalPages}`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(
            `gacha:log_page:${targetUid}:${pageType}:${poolId}:${Math.min(totalPages - 1, page + 1)}`,
          )
          .setLabel("▶")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages - 1),
      );
      components.push(pageRow);
    }
  }

  await interaction.editReply({
    content: customContent,
    files: [attachment],
    components,
  });
}

export async function handleGachaView(
  ctx: GachaContext,
  interaction: ChatInputCommandInteraction,
) {
  const { tr, db } = ctx;

  await interaction.deferReply();

  const targetUser =
    interaction.options.getUser("user") || interaction.user;

  const targetUidOption = interaction.options.getString("account");
  let targetUid = targetUidOption;

  if (!targetUid) {
    const userId = targetUser.id;
    const allRoles = await getAllPossibleUserRoles(userId, db);

    if (allRoles.length > 0) {
      // Try to find the first bound role that actually has gacha log data
      for (const role of allRoles) {
        const hasData = await db.get(`GACHA_LOG_${role.uid}`);
        if (hasData) {
          targetUid = role.uid;
          break;
        }
      }
    }

    // If no bound account has data, check for guest logs associated with this user
    if (!targetUid) {
      const userLogs = db
        .findFieldByGlobPrefix(
          `GACHA_LOG_EF_GUEST_${userId}_`,
          "$.info.export_timestamp",
        )
        .sort((a, b) => Number(b.field || 0) - Number(a.field || 0));

      if (userLogs.length > 0) {
        targetUid = userLogs[0].id.replace("GACHA_LOG_", "");
      } else if (allRoles.length > 0) {
        // If they have bound accounts but NO data anywhere
        targetUid = allRoles[0].uid;
      } else {
        // No bound accounts, no guest logs
        await interaction.editReply({
          content: tr("gacha_log_NoData", {
            user: targetUser.toString(),
          }),
        });
        return;
      }
    }
  }

  // Guest Migration logic if viewing own guest log
  if (
    (targetUid.startsWith("EF_GUEST_") ||
      targetUid === "EF_undefined") &&
    targetUser.id === interaction.user.id
  ) {
    const accounts = await getAccounts(db, interaction.user.id);
    const roles: { uid: string; nickname: string }[] = [];
    if (accounts) {
      for (const acc of accounts) {
        if (acc.roles) {
          for (const binding of acc.roles) {
            if (!binding.roles || binding.roles.length === 0) {
              roles.push({
                uid: `EF_${binding.uid}`,
                nickname:
                  binding.nickName || binding.nickname || "Unknown",
              });
              continue;
            }
            for (const role of binding.roles) {
              roles.push({
                uid: `EF_${role.roleId || role.uid || binding.uid}`,
                nickname:
                  role.nickname ||
                  role.nickName ||
                  binding.nickName ||
                  binding.nickname ||
                  "Unknown",
              });
            }
          }
        }
      }
    }

    if (roles.length === 1) {
      const targetAccount = roles[0];
      const migrated = await migrateGachaLog(
        db,
        targetUid,
        targetAccount.uid,
        interaction.user.displayName,
        1,
      );
      if (migrated) {
        targetUid = targetAccount.uid;
        await interaction.followUp({
          content: tr("gacha_log_migrate_AutoSuccess", {
            nickname: targetAccount.nickname,
          }),
          flags: MessageFlags.Ephemeral,
        });
      }
    } else if (roles.length > 1) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`gacha:log_migrate_select:${targetUid}`)
        .setPlaceholder(tr("gacha_log_view_SelectPool"))
        .addOptions(
          roles.map((r) => ({
            label: `${r.nickname} (${r.uid})`,
            value: r.uid,
          })),
        );
      const row =
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          menu,
        );
      await interaction.editReply({
        content: tr("gacha_log_migrate_Prompt"),
        components: [row],
      });
    }
  }

  // Recovery check: if targetUid has no data but EF_undefined has, offer recovery
  if (
    targetUser.id === interaction.user.id &&
    targetUid !== "EF_undefined"
  ) {
    const currentData = await db.get(`GACHA_LOG_${targetUid}`);
    if (!currentData) {
      const recoveryData = await db.get(`GACHA_LOG_EF_undefined`);
      if (recoveryData) {
        const recoverBtn = new ButtonBuilder()
          .setCustomId(`gacha:log_recover:${targetUid}`)
          .setLabel(tr("gacha_log_recover_Button"))
          .setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          recoverBtn,
        );
        await interaction.editReply({
          content: tr("gacha_log_recover_Prompt"),
          components: [row],
        });
        return;
      }
    }
  }

  await showGachaStats(ctx, targetUid, "limited_char");
  return;
}
