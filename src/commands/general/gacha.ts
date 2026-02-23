import {
  SlashCommandBuilder,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  ButtonInteraction,
  AttachmentBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { getCharacterPool, getWeaponPool } from "../../utils/skportApi";
import {
  ensureAccountBinding,
  getAccounts,
  withAutoRefresh,
} from "../../utils/accountUtils";
import {
  fetchAndMergeGachaLog,
  getGachaStats,
  GachaLogData,
  GachaLeaderboardEntry,
  syncExistingLogsToLeaderboard,
} from "../../utils/gachaLogUtils";
import {
  drawGachaStats,
  GachaType,
  getDetailedPageCount,
} from "../../utils/gachaCanvasUtils";
import { drawGachaLeaderboard } from "../../utils/gachaLeaderboardCanvasUtils";
import moment from "moment";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("gacha")
    .setNameLocalizations({
      "zh-TW": "抽卡",
    })
    .setDescription("Gacha related commands")
    .setDescriptionLocalizations({
      "zh-TW": "抽卡相關指令",
    })
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setNameLocalizations({
          "zh-TW": "卡池列表",
        })
        .setDescription("Display current character and weapon pools")
        .setDescriptionLocalizations({
          "zh-TW": "顯示當前的角色池以及武器池",
        }),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("log")
        .setNameLocalizations({
          "zh-TW": "紀錄",
        })
        .setDescription("Gacha log related commands")
        .setDescriptionLocalizations({
          "zh-TW": "抽卡紀錄相關指令",
        })
        .addSubcommand((sub) =>
          sub
            .setName("how")
            .setNameLocalizations({
              "zh-TW": "如何獲取",
            })
            .setDescription("How to get gacha log URL")
            .setDescriptionLocalizations({
              "zh-TW": "如何獲取抽卡紀錄網址",
            }),
        )
        .addSubcommand((sub) =>
          sub
            .setName("load")
            .setNameLocalizations({
              "zh-TW": "載入",
            })
            .setDescription("Load gacha log from URL via modal")
            .setDescriptionLocalizations({
              "zh-TW": "從網址載入抽卡紀錄 (彈出視窗)",
            }),
        )
        .addSubcommand((sub) =>
          sub
            .setName("view")
            .setNameLocalizations({
              "zh-TW": "查看統計",
            })
            .setDescription("View your gacha statistics")
            .setDescriptionLocalizations({
              "zh-TW": "查看您的抽卡統計數據圖",
            })
            .addUserOption((option) =>
              option
                .setName("user")
                .setNameLocalizations({
                  "zh-TW": "使用者",
                })
                .setDescription("The user to view stats for")
                .setDescriptionLocalizations({
                  "zh-TW": "要查看其統計數據的使用者",
                })
                .setRequired(false),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("leaderboard")
            .setNameLocalizations({
              "zh-TW": "排行榜",
            })
            .setDescription("View gacha leaderboard")
            .setDescriptionLocalizations({
              "zh-TW": "查看抽卡排行榜",
            }),
        ),
    ),

  execute: async (
    client,
    interaction:
      | ChatInputCommandInteraction
      | ModalSubmitInteraction
      | StringSelectMenuInteraction
      | ButtonInteraction,
    tr,
    db,
  ) => {
    const subcommandGroup = interaction.isChatInputCommand()
      ? interaction.options.getSubcommandGroup(false)
      : null;
    const subcommand = interaction.isChatInputCommand()
      ? interaction.options.getSubcommand(false)
      : null;

    async function showGachaStats(
      targetUid: string,
      pageType: GachaType,
      poolId: string = "",
      page: number = 0,
      customContent: string | null = null,
    ) {
      const dbKey = `GACHA_LOG_${targetUid}`;
      const data = await db.get<GachaLogData>(dbKey);

      if (!data) {
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
            if (charPool.type?.includes("Beginner")) pageType = "beginner_char";
            else if (
              charPool.type?.includes("Standard") ||
              charPool.type?.includes("Classic")
            )
              pageType = "standard_char";
            else pageType = "limited_char";
          }
        }
      }

      // Enrich data with account nickname if available
      if (!data.info.nickname) {
        // Try to look up from the requesting user's accounts
        const reqUserId = interaction.user.id;
        const reqAccounts = await getAccounts(db, reqUserId);
        const matchingAccount = reqAccounts?.find((acc: any) =>
          acc.roles?.some?.((r: any) => `EF_${r.uid}` === targetUid),
        );
        if (matchingAccount?.info?.nickname) {
          data.info.nickname = matchingAccount.info.nickname;
          await db.set(`GACHA_LOG_${targetUid}`, data);
        }
      }

      // Filter pools based on current category
      const targetStats = pageType === "weapon" ? stats.weapon : stats.char;
      const filteredPools = targetStats.pools.filter((p: any) => {
        if (pageType === "weapon") return p.type?.includes("Weapon");
        if (pageType === "standard_char") return p.type?.includes("Standard");
        if (pageType === "beginner_char") return p.type?.includes("Beginner");
        return p.type?.includes("Special"); // Default to Special for limited_char
      });

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
                label: tr("gacha_log_stats_StandardCharPool"),
                value: "standard_char",
                default: pageType === "standard_char",
              },
              {
                label: tr("gacha_log_stats_WeaponPool"),
                value: "weapon",
                default: pageType === "weapon",
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
      );
      const attachment = new AttachmentBuilder(image, {
        name: "gacha_stats.png",
      });

      // Build pagination buttons only for detailed mode
      const components: any[] = [poolRow, typeRow];
      if (poolId && poolId !== "all") {
        const targetStats = pageType === "weapon" ? stats.weapon : stats.char;
        const pool = targetStats.pools.find((p: any) => p.id === poolId);
        let gId = "SpecialShared";
        if (pageType === "weapon") gId = pool?.id || poolId;
        else if (pool?.type?.includes("Beginner")) gId = "Beginner";
        else if (pool?.type?.includes("Standard")) gId = `Standard_${pool.id}`;
        const gSummary = targetStats.summary;
        const pityData = gSummary[gId];
        const isBeginner = gId === "Beginner";
        const newestPoolId = targetStats.pools[0]?.id;
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

    async function showGachaLeaderboard(
      poolId: string = "TOTAL",
      sortType: "pulls" | "luck" = "luck",
    ) {
      let entriesMap =
        (await db.get<Record<string, GachaLeaderboardEntry>>(
          "GACHA_LEADERBOARD_ENTRIES",
        )) || {};

      let entries = Object.values(entriesMap);

      // Only re-sync if: no data exists, or any entry has corrupt null values in TOTAL stats
      const hasCorruptData =
        entries.length === 0 ||
        entries.some(
          (e) =>
            e.stats?.TOTAL &&
            (e.stats.TOTAL.sixStarCount === null ||
              e.stats.TOTAL.fiveStarCount === null ||
              e.stats.TOTAL.probability === null),
        );

      if (hasCorruptData) {
        await syncExistingLogsToLeaderboard(db);
        entriesMap =
          (await db.get<Record<string, GachaLeaderboardEntry>>(
            "GACHA_LEADERBOARD_ENTRIES",
          )) || {};
        entries = Object.values(entriesMap);
      }

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

      // Determine Category derived from poolId
      let currentCategory = "TOTAL";
      if (poolId === "SpecialShared") currentCategory = "Special";
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
            .setCustomId(`gacha:lb_pool:${poolId}:${sortType}`)
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
            .setCustomId(`gacha:lb_subpool:${poolId}:${sortType}`)
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
            .setCustomId(`gacha:lb_sort:${poolId}:${sortType}`)
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

      // Get game UID and pool names for canvas
      const accounts2 = await getAccounts(db, interaction.user.id);
      const gameUid2 = accounts2?.[0]?.roles?.[0]?.uid
        ? `EF_${accounts2[0].roles![0].uid}`
        : interaction.user.id;
      const poolNamesDict: Record<string, string> =
        (await db.get<Record<string, string>>("GACHA_POOL_NAMES")) || {};

      const image = await drawGachaLeaderboard(
        entries,
        gameUid2,
        poolId,
        sortType,
        tr,
        poolNamesDict,
      );

      const attachment = new AttachmentBuilder(image, {
        name: "gacha_leaderboard.png",
      });

      await interaction.editReply({
        content: null,
        files: [attachment],
        components,
      });
    }

    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;
      const parts = customId.split(":");
      const action = parts[1];
      const targetUid = parts[2];

      if (action === "log_type") {
        await interaction.deferUpdate();
        const selectedType = interaction.values[0] as GachaType;
        // Always reset to overview when changing pool type (the old pool belongs to a different type)
        await showGachaStats(targetUid, selectedType, undefined, 0);
        return;
      } else if (action === "log_pool") {
        await interaction.deferUpdate();
        const poolId = interaction.values[0];
        const currentType = parts[3] as GachaType;
        await showGachaStats(
          targetUid,
          currentType,
          poolId === "all" ? undefined : poolId,
          0,
        );
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

        await showGachaLeaderboard(newPool, newSort);
        return;
      }
    }

    if (interaction.isButton?.()) {
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
        await showGachaStats(targetUid, pageType, poolId, gotoPage);
        return;
      }
    }

    if (interaction.isChatInputCommand()) {
      if (subcommandGroup === "log") {
        if (subcommand === "how") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await interaction.editReply({
            content: `${tr("gacha_log_how_Title")}\n\n${tr("gacha_log_how_Steps")}`,
          });
          return;
        }

        if (subcommand === "load") {
          const modal = new ModalBuilder()
            .setCustomId("gacha:log_load")
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

        if (subcommand === "view") {
          await interaction.deferReply();

          const targetUser =
            interaction.options.getUser("user") || interaction.user;

          // Find bound account
          const userId = targetUser.id;
          const accounts = await getAccounts(db, userId);
          if (!accounts || accounts.length === 0) {
            await interaction.editReply({
              content: tr("AccountNotFoundUser", {
                user: targetUser.toString(),
              }),
            });
            return;
          }

          const account = accounts[0];
          // Only ensure binding if roles are missing.
          // For viewing logs, we don't need a proactive token health check if we already have the UID.
          if (!account.roles || account.roles.length === 0) {
            await ensureAccountBinding(account, userId, db, tr.lang);
          }

          const gameUid = account.roles?.[0]?.uid;
          if (!gameUid) {
            await interaction.editReply({
              content: tr("daily_RoleNotFound"),
            });
            return;
          }

          const targetUid = `EF_${gameUid}`;
          console.log(`[Gacha View] Showing stats for UID: ${targetUid}`);

          await showGachaStats(targetUid, "limited_char");
          return;
        }

        if (subcommand === "leaderboard") {
          await interaction.deferReply();
          await showGachaLeaderboard("TOTAL", "pulls");
          return;
        }
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "gacha:log_load") {
        await interaction.deferReply();

        // Show loading message
        await interaction.editReply({
          content: tr("gacha_log_load_Loading"),
        });

        const url = interaction.fields.getTextInputValue("url");

        try {
          const userId = interaction.user.id;
          const accounts = await getAccounts(db, userId);
          const account = accounts?.[0];

          let targetUid: string | undefined = undefined;
          if (account) {
            await ensureAccountBinding(account, userId, db, tr.lang);
            const gameUid = account.roles?.[0]?.uid;
            if (gameUid) targetUid = `EF_${gameUid}`;
          }

          console.log(
            `[Gacha Load] Starting merge for UID: ${targetUid || "extracted from URL"}`,
          );

          const result = await fetchAndMergeGachaLog(
            db,
            url,
            (msg) => console.log(msg),
            targetUid,
            tr.lang,
            interaction.user.displayAvatarURL({ extension: "png", size: 128 }),
          );

          const successMsg = tr("gacha_log_load_Success", {
            uid: result.data.info.uid,
            charCount: String(result.totalChar || 0),
            weaponCount: String(result.totalWeapon || 0),
          });

          if (targetUid) {
            await showGachaStats(targetUid, "limited_char", "", 0, successMsg);
          } else {
            // Fallback just in case targetUid is empty (though unlikely after successful merge)
            await showGachaStats(
              `EF_${result.data.info.uid}`,
              "limited_char",
              "",
              0,
              successMsg,
            );
          }
        } catch (error: any) {
          console.error("Gacha load error:", error);
          const errorMsg =
            error.message === "Invalid URL: Missing token or server_id"
              ? tr("gacha_log_load_InvalidUrl")
              : tr("gacha_log_load_Error", { error: error.message });

          await interaction.editReply({
            content: errorMsg,
          });
        }
        return;
      }
    }

    if (interaction.isChatInputCommand() && subcommand === "list") {
      // Default gacha command logic (display pools)
      await interaction.deferReply({
        flags: MessageFlags.IsComponentsV2 as any,
      });

      try {
        const userId = interaction.user.id;
        const accounts = await getAccounts(db, userId);
        const account = accounts?.[0] || {}; // Use first account for salt if exists

        let charPoolData: any;
        let weaponPoolData: any;

        try {
          if (account.cookie) {
            charPoolData = await withAutoRefresh(
              client,
              userId,
              account,
              (c, s, options) =>
                getCharacterPool(interaction.locale, c, s, options),
              tr.lang,
            );
            weaponPoolData = await withAutoRefresh(
              client,
              userId,
              account,
              (c, s, options) =>
                getWeaponPool(interaction.locale, c, s, options),
              tr.lang,
            );
          } else {
            charPoolData = await getCharacterPool(interaction.locale);
            weaponPoolData = await getWeaponPool(interaction.locale);
          }
        } catch (e: any) {
          if (e.message === "TokenExpired") {
            charPoolData = { code: 10000 };
          } else {
            throw e;
          }
        }

        const container = new ContainerBuilder();

        // Title
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(tr("gacha_Title")),
        );

        let hasData = false;

        // --- Character Pools ---
        if (
          charPoolData &&
          charPoolData.code === 0 &&
          charPoolData.data.list.length > 0
        ) {
          for (const charPool of charPoolData.data.list) {
            const nowTs = Math.floor(Date.now() / 1000);

            // Asia (UTC+8) - base timestamp from API
            const asiaEndTs = Number(charPool.poolEndAtTs);
            // Americas/Europe - roughly 13 hours after Asia if local time is same
            const globalEndTs = asiaEndTs + 13 * 3600;

            const charPoolHeader =
              `## ${charPool.name}\n` +
              `${tr("gacha_Global_End", { globalEndTs: `<t:${globalEndTs}:f>`, globalEndTsRelative: `<t:${globalEndTs}:R>` })}\n` +
              `${tr("gacha_Asia_End", { asiaEndTs: `<t:${asiaEndTs}:f>`, asiaEndTsRelative: `<t:${asiaEndTs}:R>` })}`;

            container.addSeparatorComponents(
              new SeparatorBuilder().setDivider(true).setSpacing(2),
            );
            container.addTextDisplayComponents(
              new TextDisplayBuilder().setContent(charPoolHeader),
            );

            const charGallery = new MediaGalleryBuilder();
            charPool.chars.forEach((c: any) => {
              if (c.pic) {
                charGallery.addItems(
                  new MediaGalleryItemBuilder({ media: { url: c.pic } }),
                );
              }
            });
            if (charGallery.items.length > 0) {
              container.addMediaGalleryComponents(charGallery);
            }
            hasData = true;
          }
        } else if (charPoolData?.code === 10000) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(tr("TokenExpired")),
          );
          hasData = true;
        } else {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(tr("gacha_CharEmpty")),
          );
          hasData = true; // Still show the message
        }

        await interaction.editReply({
          content: "",
          flags: MessageFlags.IsComponentsV2 as any,
          components: [container],
        });
      } catch (error) {
        console.error("Error in gacha command:", error);
        try {
          if (!(interaction as any).ephemeral) {
            await interaction.deleteReply().catch(() => {});
          }
        } catch {}
        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(tr("UnknownError")),
        );
        await interaction.followUp({
          content: "",
          flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as any,
          components: [container],
        });
      }
    }
  },
};

export default command;
