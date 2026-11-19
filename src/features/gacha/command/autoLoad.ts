import {
  getAccounts,
} from "../../../utils/accountUtils";
import {
  fetchAndMergeGachaLogFromAccount,
} from "../../../utils/gachaLogUtils";
import {
  IncompleteFetch,
  takeIncompleteFetches,
} from "../gachaApi";
import { MessageFlags } from "discord.js";
import { GachaContext } from "./context";
import { getAllPossibleUserRoles, findLinkedAccount } from "./accounts";

/** Human label of a character pool type (the importer's raw type name otherwise). */
export function charPoolTypeLabel(rawPoolType: string, tr: any): string {
  const t = String(rawPoolType || "");
  if (t.includes("Standard")) return tr("gacha_log_load_pool_type_standard");
  if (t.includes("Rerun")) return tr("gacha_log_stats_RerunCharPool");
  if (t.includes("Special")) return tr("gacha_log_load_pool_type_limited");
  if (t.includes("Beginner")) return tr("gacha_log_load_pool_type_beginner");
  return t.replace("E_CharacterGachaPoolType_", "");
}

/** One line per part of an import that could not be fetched. */
export function describeIncompleteFetches(
  incomplete: IncompleteFetch[],
  tr: any,
): string[] {
  return incomplete.map((item) => {
    const name =
      item.poolType === "WeaponPool"
        ? item.poolId
          ? tr("gacha_import_part_weapon_pool", { poolId: item.poolId })
          : tr("gacha_import_part_weapon_list")
        : charPoolTypeLabel(item.poolType, tr);
    return `• ${name} (${item.reason})`;
  });
}

/**
 * After an import: if parts of the history could not be fetched, say so
 * instead of letting the result pass for a complete one.
 */
export async function notifyIncompleteImport(
  ctx: GachaContext,
  onProgressUpdate: (message: string) => void,
): Promise<boolean> {
  const incomplete = takeIncompleteFetches(onProgressUpdate);
  if (incomplete.length === 0) return false;
  try {
    await ctx.interaction.followUp({
      content: ctx.tr("gacha_log_load_incomplete", {
        parts: describeIncompleteFetches(incomplete, ctx.tr).join("\n"),
      }),
      flags: MessageFlags.Ephemeral,
    });
  } catch {}
  return true;
}

export function buildProgressHandlers(ctx: GachaContext) {
  const { interaction, tr, isZhLocale } = ctx;
  const poolProgressMap = new Map<string, string>();
  let miscProgress = "";
  let lastRenderedProgress = "";
  let progressTimer: NodeJS.Timeout | null = null;

  const mapCharPoolTypeName = (rawPoolType: string): string =>
    charPoolTypeLabel(rawPoolType, tr);

  const onProgressUpdate = (raw: string) => {
    const charMatch = raw.match(
      /^Fetching character records \((.+), page (\d+)\)\.\.\.$/i,
    );
    if (charMatch) {
      poolProgressMap.set(
        charMatch[1],
        tr("gacha_log_load_progress_char", {
          poolName: mapCharPoolTypeName(charMatch[1]),
          pageNo: charMatch[2],
        }),
      );
      miscProgress = "";
      return;
    }
    const weaponMatch = raw.match(
      /^Fetching weapon records \((.+), page (\d+)\)\.\.\.$/i,
    );
    if (weaponMatch) {
      poolProgressMap.set(
        `weapon_${weaponMatch[1]}`,
        tr("gacha_log_load_progress_weapon", {
          poolName: weaponMatch[1],
          pageNo: weaponMatch[2],
        }),
      );
      miscProgress = "";
      return;
    }
    if (/^Fetching weapon pools/i.test(raw)) {
      miscProgress = tr("gacha_log_load_progress_weapon_list");
      return;
    }
    miscProgress = isZhLocale ? "" : raw;
  };

  const renderProgress = async () => {
    const lines = [tr("gacha_log_load_Loading")];
    if (miscProgress) lines.push(miscProgress);
    for (const line of poolProgressMap.values()) lines.push(line);
    const content = lines.join("\n");
    if (content === lastRenderedProgress) return;
    lastRenderedProgress = content;
    try {
      await interaction.editReply({ content });
    } catch {}
  };

  const start = async () => {
    await renderProgress();
    progressTimer = setInterval(() => void renderProgress(), 5000);
  };

  const stop = () => {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  };

  return { onProgressUpdate, start, stop };
}

export async function tryAutoLoadGachaLog(
  ctx: GachaContext,
  targetUid: string,
): Promise<boolean> {
  const { interaction, tr, db } = ctx;
  try {
    const userAccounts = await getAccounts(db, interaction.user.id);
    if (!userAccounts?.length) return false;

    const allRoles = await getAllPossibleUserRoles(interaction.user.id, db);
    const matchedRole = allRoles.find((r) => r.uid === targetUid);
    const efGameUid = matchedRole?.bindingUid || matchedRole?.rawUid;
    if (!efGameUid) return false;

    // Find the account that owns this specific game UID
    const linkedAccount = findLinkedAccount(userAccounts, efGameUid);
    if (!linkedAccount) return false;

    const accountIndex = allRoles.findIndex((r) => r.uid === targetUid) + 1;
    const { onProgressUpdate, start, stop } = buildProgressHandlers(ctx);

    await interaction.editReply({ content: tr("gacha_log_load_Loading") });
    await start();
    try {
      await fetchAndMergeGachaLogFromAccount(
        db,
        linkedAccount.cookie,
        efGameUid,
        "gryphline",
        targetUid,
        onProgressUpdate,
        tr.lang,
        interaction.user.displayAvatarURL({ extension: "png", size: 128 }),
        interaction.user.displayName,
        accountIndex > 0 ? accountIndex : undefined,
        matchedRole?.nickname,
      );
      stop();
      await notifyIncompleteImport(ctx, onProgressUpdate);
      return true;
    } catch {
      stop();
      return false;
    }
  } catch {
    return false;
  }
}
