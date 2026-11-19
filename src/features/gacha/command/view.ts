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
} from "../../../utils/gachaLogUtils";
import { getCachedGachaStats } from "../gachaStatsCache";
import {
  drawGachaStats,
  GachaType,
  getDetailedPageCount,
} from "../../../utils/gachaCanvasUtils";
import moment from "moment";
import {
  findPoolPage,
  getGachaPityGroupId,
  isGachaPoolInCategory,
  pagePoolOptions,
  paginateGachaOverviewPools,
  parsePoolPageValue,
  poolPageValue,
} from "../../../utils/gachaPoolUtils";
import { GachaContext } from "./context";
import {
  getAllPossibleUserRoles,
  mapPossibleUserRoles,
  PossibleUserRole,
} from "./accounts";
import { tryAutoLoadGachaLog } from "./autoLoad";

/** Pure: is the stored nickname just the UID (or empty / "Unknown")? */
export function isGenericNickname(
  nickname: string | undefined,
  targetUid: string,
): boolean {
  const rawUid = targetUid.replace("EF_CN_", "").replace("EF_", "");
  return (
    !nickname ||
    nickname === targetUid ||
    nickname === rawUid ||
    nickname === "Unknown"
  );
}

/** Pure: the nickname to draw for a log whose stored nickname is generic. */
export function pickDisplayNickname(
  stored: string | undefined,
  targetUid: string,
  roles: PossibleUserRole[],
): string | undefined {
  const found = roles.find((r) => r.uid === targetUid);
  if (found) return found.nickname;
  if (targetUid.startsWith("EF_GUEST_")) return "Guest";
  return stored;
}

/**
 * Pure: may `ownerId`'s log be opened under `requestedUid`? The UID has to be
 * one of the owner's own: a linked game role (global / CN key form or the bare
 * id the oldest logs used) or one of their guest logs (the guest key embeds
 * the Discord id of its creator).
 */
export function resolveViewableGachaUid(
  requestedUid: string,
  ownerId: string,
  ownerRoles: PossibleUserRole[],
): { ok: true; uid: string } | { ok: false } {
  const uid = String(requestedUid || "");
  if (!uid) return { ok: false };
  for (const r of ownerRoles) {
    if (uid === r.uid || (r.rawUid && uid === String(r.rawUid))) {
      return { ok: true, uid };
    }
  }
  const guestPrefix = `EF_GUEST_${ownerId}_`;
  if (
    ownerId &&
    uid.startsWith(guestPrefix) &&
    /^[A-Za-z0-9_-]+$/.test(uid.slice(guestPrefix.length))
  ) {
    return { ok: true, uid };
  }
  return { ok: false };
}

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

  // A repeat view reads only the small cache row and writes nothing; the log row
  // (up to several MB of JSON) is parsed only when the log has changed.
  const cached = await getCachedGachaStats(db, dbKey, (log) =>
    getGachaStats(db, log),
  );

  if (!cached) {
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

  const stats = cached.stats;

  // The pool select's "older / newer" entries re-render the overview with
  // another page of pool options.
  let poolSelectPage = parsePoolPageValue(poolId);
  if (poolSelectPage !== null) poolId = "";

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

  // The card only needs the log's info block; it is part of the cache row.
  // A generic nickname is fixed for display only (nothing is written back).
  const info = { ...cached.info };
  if (isGenericNickname(info.nickname, targetUid)) {
    const viewerRoles = async (refresh: boolean) =>
      refresh
        ? getAllPossibleUserRoles(interaction.user.id, db)
        : mapPossibleUserRoles(await getAccounts(db, interaction.user.id));
    let roles = await viewerRoles(false);
    // Refresh the bindings only when the cached mapping does not know this UID
    // and the stats had to be computed anyway.
    if (!cached.hit && !roles.some((r) => r.uid === targetUid)) {
      roles = await viewerRoles(true);
    }
    info.nickname = pickDisplayNickname(info.nickname, targetUid, roles);
  }
  const data: GachaLogData = { characterList: [], weaponList: [], info };

  // Filter pools based on current category
  const targetStats = pageType === "weapon" ? stats.weapon : stats.char;
  const filteredPools = targetStats.pools.filter((p: any) =>
    isGachaPoolInCategory(p, pageType),
  );

  if (poolSelectPage === null) {
    poolSelectPage =
      poolId && poolId !== "all" ? findPoolPage(filteredPools, poolId) : 0;
  }
  const poolOptionPage = pagePoolOptions(filteredPools, poolSelectPage);
  const pageSuffix = {
    page: String(poolOptionPage.page + 1),
    total: String(poolOptionPage.totalPages),
  };

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
          ...poolOptionPage.items.map((p) => {
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
          ...(poolOptionPage.hasNewer
            ? [
                {
                  label: tr("gacha_log_view_PoolsNewer"),
                  value: poolPageValue(poolOptionPage.page - 1),
                  description: tr("gacha_log_view_PoolsPage", pageSuffix),
                },
              ]
            : []),
          ...(poolOptionPage.hasOlder
            ? [
                {
                  label: tr("gacha_log_view_PoolsOlder"),
                  value: poolPageValue(poolOptionPage.page + 1),
                  description: tr("gacha_log_view_PoolsPage", pageSuffix),
                },
              ]
            : []),
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

  // The log of someone else stays viewable only through `user:`; `account:`
  // must name one of that user's own UIDs (never an arbitrary key).
  if (targetUid) {
    const ownerRoles = mapPossibleUserRoles(
      await getAccounts(db, targetUser.id),
    );
    const allowed = resolveViewableGachaUid(
      targetUid,
      targetUser.id,
      ownerRoles,
    );
    if (!allowed.ok) {
      await interaction.editReply({
        content: tr("gacha_log_view_AccountNotOwned", {
          user: targetUser.toString(),
        }),
      });
      return;
    }
    targetUid = allowed.uid;
  }

  if (!targetUid) {
    const userId = targetUser.id;
    // Cached binding mapping first (no SKPort call); refresh only when the
    // user has no known roles at all.
    let allRoles = mapPossibleUserRoles(await getAccounts(db, userId));
    if (allRoles.length === 0) {
      allRoles = await getAllPossibleUserRoles(userId, db);
    }

    if (allRoles.length > 0) {
      // Try to find the first bound role that actually has gacha log data
      for (const role of allRoles) {
        const hasData = db.getRowToken(`GACHA_LOG_${role.uid}`) !== null;
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
    const currentData = db.getRowToken(`GACHA_LOG_${targetUid}`);
    if (!currentData) {
      const recoveryData = db.getRowToken(`GACHA_LOG_EF_undefined`);
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
