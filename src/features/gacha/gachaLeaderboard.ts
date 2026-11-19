import { CustomDatabase } from "../../utils/Database";
import { getGachaStats } from "./gachaStatsEngine";
import { GachaLeaderboardEntry, GachaLogData, GachaRecord, isGachaPull, isPullFree } from "./gachaTypes";

function indexGachaLogRecords(
  data: GachaLogData,
): Map<string, string> | undefined {
  const indexed = new Map<string, string>();
  for (const [kind, records] of [
    ["char", data.characterList],
    ["weapon", data.weaponList],
  ] as const) {
    if (!Array.isArray(records)) return undefined;
    for (const record of records) {
      const seqId = String(record?.seqId ?? "");
      if (!seqId) return undefined;
      const key = `${kind}:${seqId}`;
      if (indexed.has(key)) return undefined;
      indexed.set(
        key,
        JSON.stringify([
          record.charId ?? "",
          record.weaponId ?? "",
          record.rarity ?? "",
          String(record.gachaTs ?? ""),
          record.poolId ?? "",
          Boolean(record.isFree),
        ]),
      );
    }
  }
  return indexed;
}

function isGachaLogSubset(
  candidate: GachaLogData,
  superset: GachaLogData,
): boolean {
  const candidateRecords = indexGachaLogRecords(candidate);
  const supersetRecords = indexGachaLogRecords(superset);
  if (
    !candidateRecords ||
    !supersetRecords ||
    candidateRecords.size === 0 ||
    candidateRecords.size > supersetRecords.size
  )
    return false;
  for (const [key, value] of candidateRecords) {
    if (supersetRecords.get(key) !== value) return false;
  }
  return true;
}

/** Filters duplicate EF/EF_CN rows only when one same-role pull history is a subset of the other. */
export async function deduplicateLeaderboardAliases(
  db: Pick<CustomDatabase, "get">,
  entries: Record<string, GachaLeaderboardEntry>,
): Promise<Record<string, GachaLeaderboardEntry>> {
  const filtered = { ...entries };
  for (const cnUid of Object.keys(filtered)) {
    const match = /^EF_CN_(\d+)$/.exec(cnUid);
    if (!match) continue;
    const rawUid = match[1];
    const globalUid = `EF_${rawUid}`;
    if (!filtered[globalUid]) continue;

    const [globalData, cnData] = await Promise.all([
      db.get<GachaLogData>(`GACHA_LOG_${globalUid}`),
      db.get<GachaLogData>(`GACHA_LOG_${cnUid}`),
    ]);
    if (!globalData || !cnData) continue;
    const normalizeUid = (uid: string | undefined) =>
      String(uid || "")
        .replace(/^EF_CN_/, "")
        .replace(/^EF_/, "");
    if (
      normalizeUid(globalData.info?.uid) !== rawUid ||
      normalizeUid(cnData.info?.uid) !== rawUid ||
      !globalData.info?.serverId ||
      String(globalData.info.serverId) !== String(cnData.info?.serverId)
    )
      continue;

    const globalIsSubset = isGachaLogSubset(globalData, cnData);
    const cnIsSubset = isGachaLogSubset(cnData, globalData);
    if (!globalIsSubset && !cnIsSubset) continue;

    const removeUid =
      globalIsSubset && cnIsSubset
        ? filtered[globalUid].lastUpdate >= filtered[cnUid].lastUpdate
          ? cnUid
          : globalUid
        : globalIsSubset
          ? globalUid
          : cnUid;
    delete filtered[removeUid];
  }
  return filtered;
}

export async function updateLeaderboard(
  db: CustomDatabase,
  uid: string,
  data: GachaLogData,
  displayName?: string,
  accountIndex?: number,
  gameNickname?: string,
) {
  const stats = await getGachaStats(db, data);
  const entry: GachaLeaderboardEntry = {
    uid,
    nickname:
      gameNickname && gameNickname !== uid
        ? gameNickname
        : data.info.nickname && data.info.nickname !== uid
          ? data.info.nickname
          : uid === "GUEST"
            ? "GUEST"
            : uid,
    displayName: displayName,
    gameNickname:
      gameNickname && gameNickname !== uid
        ? gameNickname
        : data.info.nickname && data.info.nickname !== uid
          ? data.info.nickname
          : undefined,
    avatarUrl: data.info.avatarUrl,
    lastUpdate: Date.now(),
    total: stats.char.total + stats.weapon.total,
    nonFreeTotal: stats.char.nonFreeTotal + stats.weapon.nonFreeTotal,
    freeTotal: stats.char.freeTotal + stats.weapon.freeTotal,
    accountIndex: accountIndex,
    stats: {},
    poolNames: {},
  };

  // Collect poolId -> poolName from all records
  const newPoolNames: Record<string, string> = {};
  for (const rec of [...data.characterList, ...data.weaponList]) {
    if (rec.poolId && rec.poolName) {
      newPoolNames[rec.poolId] = rec.poolName;
      if (entry.poolNames) entry.poolNames[rec.poolId] = rec.poolName;
    }
  }

  // Merge into global pool name dictionary (shared across all users)
  const globalPoolNames =
    (await db.get<Record<string, string>>("GACHA_POOL_NAMES")) || {};
  const mergedPoolNames = { ...globalPoolNames, ...newPoolNames };
  await db.set("GACHA_POOL_NAMES", mergedPoolNames);

  const processGroup = (gId: string, s: any) => {
    if (!s) return;
    const total = Number(s.nonFreeTotal || 0);
    const six = Number(s.sixStarCount || 0);
    const five = Number(s.fiveStarCount || 0);
    entry.stats[gId] = {
      total,
      sixStarCount: six,
      fiveStarCount: five,
      probability: total > 0 ? six / total : 0,
    };
  };

  for (const gId of Object.keys(stats.char.summary)) {
    processGroup(gId, stats.char.summary[gId]);
  }
  for (const gId of Object.keys(stats.weapon.summary)) {
    processGroup(gId, stats.weapon.summary[gId]);
  }

  // Add category shared stats to leaderboard entry
  processGroup("SpecialShared", stats.char.summary["SpecialShared"]);
  processGroup("StandardShared", stats.char.StandardShared);
  processGroup("WeaponShared", stats.weapon.WeaponShared);

  // Calculate TOTAL using the new explicit total metrics
  const totalNonFree = stats.char.nonFreeTotal + stats.weapon.nonFreeTotal;
  const totalFree = stats.char.freeTotal + stats.weapon.freeTotal;
  const totalAll = stats.char.total + stats.weapon.total;

  const totalSix =
    Object.values(stats.char.summary).reduce(
      (a, b) => a + Number((b as any).sixStarCount || 0),
      0,
    ) +
    Object.values(stats.weapon.summary).reduce(
      (a, b) => a + Number((b as any).sixStarCount || 0),
      0,
    );
  const totalFive =
    Object.values(stats.char.summary).reduce(
      (a, b) => a + Number((b as any).fiveStarCount || 0),
      0,
    ) +
    Object.values(stats.weapon.summary).reduce(
      (a, b) => a + Number((b as any).fiveStarCount || 0),
      0,
    );

  entry.stats["TOTAL"] = {
    total: Number(totalNonFree || 0),
    sixStarCount: Number(totalSix || 0),
    fiveStarCount: Number(totalFive || 0),
    probability: totalNonFree > 0 ? Number(totalSix || 0) / totalNonFree : 0,
  };

  // Also compute per-poolId stats from raw records (for sub-pool leaderboard)
  // This handles cases where getPityGroupId merges pools (e.g. SpecialShared)
  const buildPerPoolStats = (list: GachaRecord[]) => {
    const grouped: Record<string, GachaRecord[]> = {};
    for (const rec of list) {
      if (!rec.poolId || !isGachaPull(rec)) continue;
      if (!grouped[rec.poolId]) grouped[rec.poolId] = [];
      grouped[rec.poolId].push(rec);
    }
    for (const [pid, recs] of Object.entries(grouped)) {
      const nonFree = recs.filter((r) => !isPullFree(r));
      const six = nonFree.filter((r) => r.rarity >= 6).length;
      const five = nonFree.filter((r) => r.rarity >= 5 && r.rarity < 6).length;
      const total = nonFree.length;
      if (!entry.stats[pid] || entry.stats[pid].total === 0) {
        entry.stats[pid] = {
          total,
          sixStarCount: six,
          fiveStarCount: five,
          probability: total > 0 ? six / total : 0,
        };
      }
    }
  };
  buildPerPoolStats(data.characterList);
  buildPerPoolStats(data.weaponList);

  db.transaction((store) => {
    // Re-read after async statistics work so concurrent deletion is never undone.
    const leaderboard =
      store.get<Record<string, GachaLeaderboardEntry>>(
        "GACHA_LEADERBOARD_ENTRIES",
      ) || {};
    if (
      !uid.startsWith("EF_GUEST_") &&
      uid !== "EF_undefined" &&
      store.get(`GACHA_LOG_${uid}`)
    )
      leaderboard[uid] = entry;
    else delete leaderboard[uid];
    store.set("GACHA_LEADERBOARD_ENTRIES", leaderboard);
  });
}

/**
 * Retrospectively sync all existing gacha logs in the database to the leaderboard
 */
export async function syncExistingLogsToLeaderboard(db: CustomDatabase) {
  const logIds = await db.findIdsByPrefix("GACHA_LOG_");

  for (const id of logIds) {
    const uid = id.replace("GACHA_LOG_", "");
    try {
      const data = await db.get<GachaLogData>(id);
      if (data) {
        await updateLeaderboard(db, uid, data);
      }
    } catch (e) {
      console.error(`[Leaderboard Sync] Failed to sync ${uid}:`, e);
    }
  }
}