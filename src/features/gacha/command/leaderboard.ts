import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  AttachmentBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import {
  getAccounts,
} from "../../../utils/accountUtils";
import {
  GachaLeaderboardEntry,
  LeaderboardScope,
  LeaderboardSort,
  buildLeaderboardView,
  deduplicateLeaderboardAliases,
  leaderboardCustomId,
  noteLeaderboardGuild,
  parseLeaderboardCustomId,
  readLeaderboardEntries,
} from "../../../utils/gachaLogUtils";
import { drawGachaLeaderboard } from "../../../utils/gachaLeaderboardCanvasUtils";
import { GachaContext } from "./context";
import { getAllPossibleUserRoles } from "./accounts";

export interface ShowLeaderboardOptions {
  scope?: LeaderboardScope;
  page?: number;
  /** Open the page that holds the invoker's best rank. */
  jumpToMe?: boolean;
}

/** Leaderboard customId with the invoker appended (7th part) for the click gate. */
export function leaderboardCustomIdFor(
  invokerId: string,
  action: Parameters<typeof leaderboardCustomId>[0],
  state: Parameters<typeof leaderboardCustomId>[1],
): string {
  return `${leaderboardCustomId(action, state)}:${invokerId}`;
}

export async function showGachaLeaderboard(
  ctx: GachaContext,
  poolId: string = "TOTAL",
  sortType: LeaderboardSort = "luck",
  opts: ShowLeaderboardOptions = {},
) {
  const { interaction, tr, db } = ctx;
  const guildId = interaction.guildId;
  const invokerId = interaction.user.id;
  // One row per UID (GACHA_LB.<uid>); the old blob is migrated on first read.
  // An empty board is never "repaired" here: re-syncing every log inside an
  // interaction would parse hundreds of MB.
  let entriesMap: Record<string, GachaLeaderboardEntry> = {};
  for (const row of await readLeaderboardEntries(db)) entriesMap[row.uid] = row;
  let entries: GachaLeaderboardEntry[];

  entriesMap = await deduplicateLeaderboardAliases(db, entriesMap);
  entries = Object.values(entriesMap);

  if (entries.length === 0) {
    await interaction.editReply({
      content: tr("gacha_log_leaderboard_Empty"),
    });
    return;
  }

  // Proactively update current user's avatar and basic info in leaderboard if they exist
  const accounts = await getAccounts(db, interaction.user.id);
  if (accounts && accounts.length > 0) {
    const gameUid = accounts[0].roles?.[0]?.uid;
    if (gameUid) {
      const targetUid = `EF_${gameUid}`;
      if (entriesMap[targetUid]) {
        entriesMap[targetUid].avatarUrl = interaction.user.displayAvatarURL(
          {
            extension: "png",
            size: 128,
          },
        );
        entriesMap[targetUid].displayName = interaction.user.displayName;
        entriesMap[targetUid].nickname =
          accounts[0].nickname || interaction.user.username;
        // No need to persist immediately, the image will use the updated object
      }
    }
  }

  // Get all game UIDs for the current user to highlight in leaderboard
  const allPossibleRoles2 = await getAllPossibleUserRoles(
    interaction.user.id,
    db,
  );
  const currentUserUids = allPossibleRoles2.map((r) => r.uid);
  if (currentUserUids.length === 0) {
    currentUserUids.push(interaction.user.id); // Fallback to discord ID if no tracking data
  }
  // The server scope only fills with people we have seen here: remember the
  // invoker's own UIDs for this guild (a no-op write-wise once they are known).
  if (guildId) {
    for (const uid of currentUserUids) {
      const row = entriesMap[uid];
      if (!row) continue;
      if (noteLeaderboardGuild(db, uid, guildId))
        row.guilds = [...(row.guilds || []), guildId];
    }
  }

  const viewOptions = {
    poolId,
    sortType,
    scope: opts.scope,
    guildId,
    myUids: currentUserUids,
  };
  let view = buildLeaderboardView(entries, { ...viewOptions, page: opts.page });
  let noRankNotice = false;
  if (opts.jumpToMe) {
    if (view.myPage === null) noRankNotice = true;
    else view = buildLeaderboardView(entries, { ...viewOptions, page: view.myPage });
  }
  const idState = (page: number = view.page) => ({
    poolId,
    sortType,
    scope: view.scope,
    page,
  });

  // Determine Category derived from poolId
  let currentCategory = "TOTAL";
  if (poolId === "SpecialShared") currentCategory = "Special";
  else if (poolId === "RerunShared" || poolId.startsWith("rerun_chr_"))
    currentCategory = "Rerun";
  else if (poolId === "StandardShared") currentCategory = "Standard";
  else if (poolId === "WeaponShared") currentCategory = "Weapon";
  else if (poolId.startsWith("special_"))
    currentCategory = "Special"; // e.g. special_1_0_1
  else if (
    poolId.startsWith("weponbox_") ||
    poolId.startsWith("weaponbox_")
  )
    currentCategory = "Weapon";
  else if (poolId.startsWith("c_special") || poolId.startsWith("w_")) {
    currentCategory = poolId.startsWith("c_special") ? "Special" : "Weapon";
  } else if (poolId.startsWith("Standard_")) {
    currentCategory = "Standard";
  }

  // 1. Category Selection Row
  const categoryOptions = [
    {
      label: tr("gacha_log_leaderboard_category_TOTAL"),
      value: "TOTAL",
      default: poolId === "TOTAL",
    },
    {
      label: tr("gacha_log_leaderboard_category_Special"),
      value: "SpecialShared",
      default: currentCategory === "Special",
    },
    {
      label: tr("gacha_log_stats_RerunCharPool"),
      value: "RerunShared",
      default: currentCategory === "Rerun",
    },
    {
      label: tr("gacha_log_leaderboard_category_Standard"),
      value: "StandardShared",
      default: currentCategory === "Standard",
    },
    {
      label: tr("gacha_log_leaderboard_category_Weapon"),
      value: "WeaponShared",
      default: currentCategory === "Weapon",
    },
  ];

  const categoryRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(leaderboardCustomIdFor(invokerId, "lb_pool", idState()))
        .setPlaceholder(tr("gacha_log_leaderboard_SelectCategory"))
        .addOptions(categoryOptions),
    );

  // 2. Pool Selection Row (only for Special/Weapon/Standard if needed)
  // For Special and Weapon, we follow the user's request: tier 2 for specific pools
  const components: any[] = [categoryRow];

  if (currentCategory === "Special" || currentCategory === "Weapon") {
    const allPoolIds = Array.from(
      new Set(entries.flatMap((e) => Object.keys(e.stats))),
    );

    // Read global pool name dictionary (populated when any user imports)
    const combinedPoolNames: Record<string, string> =
      (await db.get<Record<string, string>>("GACHA_POOL_NAMES")) || {};

    // Filter to only individual pools (not shared aggregates or TOTAL)
    const filteredPools = allPoolIds
      .filter((id) => {
        if (currentCategory === "Special") {
          return id.startsWith("special_"); // e.g. special_1_0_1, special_1_0_3
        } else {
          // Weapon: weponbox_* or weaponbox_*
          return id.startsWith("weponbox_") || id.startsWith("weaponbox_");
        }
      })
      .sort((a, b) => b.localeCompare(a)); // Newest first

    if (filteredPools.length > 0) {
      const poolMenu = new StringSelectMenuBuilder()
        .setCustomId(leaderboardCustomIdFor(invokerId, "lb_subpool", idState()))
        .setPlaceholder(
          tr("gacha_log_leaderboard_SelectPoolPrecise", {
            category:
              currentCategory === "Special"
                ? tr("canvas_Operators")
                : tr("canvas_Weapons"),
          }),
        )
        .addOptions([
          {
            label: tr("gacha_log_leaderboard_CategoryTotal", {
              category:
                currentCategory === "Special"
                  ? tr("gacha_log_stats_LimitedCharPool")
                  : tr("gacha_log_stats_WeaponPool"),
            }),
            value:
              currentCategory === "Special"
                ? "SpecialShared"
                : "WeaponShared",
            default:
              poolId === "SpecialShared" || poolId === "WeaponShared",
          },
          ...filteredPools.slice(0, 24).map((id) => ({
            label: combinedPoolNames[id] || id, // Human-readable name if available
            value: id,
            default: poolId === id,
          })),
        ]);
      components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          poolMenu,
        ),
      );
    }
  }

  // 3. Sort Selection Row
  const sortRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(leaderboardCustomIdFor(invokerId, "lb_sort", idState()))
        .setPlaceholder(tr("gacha_log_leaderboard_SelectSort"))
        .addOptions([
          {
            label: tr("gacha_log_leaderboard_sort_luck"),
            value: "luck",
            default: sortType === "luck",
          },
          {
            label: tr("gacha_log_leaderboard_sort_pulls"),
            value: "pulls",
            default: sortType === "pulls",
          },
        ]),
    );
  components.push(sortRow);

  // 4. Scope row (a DM has no server to scope to)
  if (guildId) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(leaderboardCustomIdFor(invokerId, "lb_scope", idState()))
          .setPlaceholder(tr("gacha_log_leaderboard_scope_placeholder"))
          .addOptions([
            {
              label: tr("gacha_log_leaderboard_scope_global"),
              emoji: "🌐",
              value: "global",
              default: view.scope === "global",
            },
            {
              label: tr("gacha_log_leaderboard_scope_guild"),
              emoji: "🏠",
              value: "guild",
              default: view.scope === "guild",
            },
          ]),
      ),
    );
  }

  // 5. Paging, "my rank" and close
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(leaderboardCustomIdFor(invokerId, "lb_page", idState(Math.max(0, view.page - 1))))
        .setEmoji("◀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view.page <= 0),
      new ButtonBuilder()
        .setCustomId(
          leaderboardCustomIdFor(invokerId, "lb_page",
            idState(Math.min(view.pageCount - 1, view.page + 1)),
          ),
        )
        .setEmoji("▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view.page >= view.pageCount - 1),
      new ButtonBuilder()
        .setCustomId(leaderboardCustomIdFor(invokerId, "lb_me", idState()))
        .setEmoji("📍")
        .setLabel(tr("gacha_log_leaderboard_my_rank"))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(leaderboardCustomIdFor(invokerId, "lb_close", idState()))
        .setEmoji("✖️")
        .setLabel(tr("gacha_log_leaderboard_close"))
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  const poolNamesDict: Record<string, string> =
    (await db.get<Record<string, string>>("GACHA_POOL_NAMES")) || {};

  const image = await drawGachaLeaderboard(
    entries,
    currentUserUids,
    poolId,
    sortType,
    tr,
    poolNamesDict,
    { view },
  );

  const attachment = new AttachmentBuilder(image, {
    name: "gacha_leaderboard.webp",
  });

  await interaction.editReply({
    content: view.scopeEmpty ? tr("gacha_log_leaderboard_scope_empty") : null,
    files: [attachment],
    components,
  });

  if (noRankNotice) {
    await interaction
      .followUp({
        content: tr("gacha_log_leaderboard_no_rank"),
        ephemeral: true,
      })
      .catch(() => undefined);
  }
}

/**
 * Every leaderboard component (selects and buttons). Returns false when the id
 * is not a leaderboard one. The interaction is acknowledged first.
 */
export async function handleGachaLeaderboardComponent(
  ctx: GachaContext,
  interaction: StringSelectMenuInteraction | ButtonInteraction,
): Promise<boolean> {
  const state = parseLeaderboardCustomId(interaction.customId);
  if (!state) return false;
  await interaction.deferUpdate();

  const selected = interaction.isStringSelectMenu() ? interaction.values[0] : "";
  switch (state.action) {
    case "lb_close":
      await interaction
        .deleteReply()
        .catch(() => interaction.editReply({ components: [] }).catch(() => undefined));
      return true;
    case "lb_pool":
    case "lb_subpool":
    case "lb_type":
      await showGachaLeaderboard(ctx, selected || state.poolId, state.sortType, {
        scope: state.scope,
      });
      return true;
    case "lb_sort":
      await showGachaLeaderboard(
        ctx,
        state.poolId,
        selected === "pulls" ? "pulls" : "luck",
        { scope: state.scope },
      );
      return true;
    case "lb_scope":
      await showGachaLeaderboard(ctx, state.poolId, state.sortType, {
        scope: selected === "guild" ? "guild" : "global",
      });
      return true;
    case "lb_me":
      await showGachaLeaderboard(ctx, state.poolId, state.sortType, {
        scope: state.scope,
        jumpToMe: true,
      });
      return true;
    case "lb_page":
    default:
      await showGachaLeaderboard(ctx, state.poolId, state.sortType, {
        scope: state.scope,
        page: state.page,
      });
      return true;
  }
}

export async function handleGachaLeaderboard(
  ctx: GachaContext,
  interaction: ChatInputCommandInteraction,
) {
  await interaction.deferReply();
  await showGachaLeaderboard(ctx, "TOTAL", "pulls");
  return;
}
