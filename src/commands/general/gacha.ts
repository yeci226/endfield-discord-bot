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
} from "../../utils/gachaLogUtils";
import {
  drawGachaStats,
  GachaType,
  getDetailedPageCount,
  ITEMS_PER_PAGE,
} from "../../utils/gachaCanvasUtils";
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
      type: GachaType = "limited_char",
      selectedPoolId?: string,
      page: number = 0,
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
      const targetStats = type === "weapon" ? stats.weapon : stats.char;
      const filteredPools = targetStats.pools.filter((p: any) => {
        if (type === "weapon") return p.type?.includes("Weapon");
        if (type === "standard_char") return p.type?.includes("Standard");
        if (type === "beginner_char") return p.type?.includes("Beginner");
        return p.type?.includes("Special"); // Default to Special for limited_char
      });

      const poolRow =
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`gacha:log_pool:${targetUid}:${type}`)
            .setPlaceholder("選擇特定期數查看詳細記錄")
            .addOptions([
              {
                label: "顯示總覽 (不選擇特定池)",
                value: "all",
                default: !selectedPoolId,
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
                  default: p.id === selectedPoolId,
                };
              }),
            ]),
        );

      const typeRow =
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(
              `gacha:log_type:${targetUid}:${selectedPoolId || "all"}`,
            )
            .setPlaceholder(tr("gacha_log_stats_SelectPool"))
            .addOptions([
              {
                label: tr("gacha_log_stats_LimitedCharPool"),
                value: "limited_char",
                default: type === "limited_char",
              },
              {
                label: tr("gacha_log_stats_StandardCharPool"),
                value: "standard_char",
                default: type === "standard_char",
              },
              {
                label: tr("gacha_log_stats_WeaponPool"),
                value: "weapon",
                default: type === "weapon",
              },
              {
                label: tr("gacha_log_stats_BeginnerCharPool") || "新手角色尋訪",
                value: "beginner_char",
                default: type === "beginner_char",
              },
            ]),
        );

      const image = await drawGachaStats(
        data,
        stats,
        tr,
        type as any,
        selectedPoolId === "all" ? undefined : selectedPoolId,
        page,
      );
      const attachment = new AttachmentBuilder(image, {
        name: "gacha_stats.png",
      });

      // Build pagination buttons only for detailed mode
      const components: any[] = [poolRow, typeRow];
      if (selectedPoolId && selectedPoolId !== "all") {
        const targetStats = type === "weapon" ? stats.weapon : stats.char;
        const pool = targetStats.pools.find(
          (p: any) => p.id === selectedPoolId,
        );
        let gId = "SpecialShared";
        if (type === "weapon") gId = pool?.id || selectedPoolId;
        else if (pool?.type?.includes("Beginner")) gId = "Beginner";
        else if (pool?.type?.includes("Standard")) gId = `Standard_${pool.id}`;
        const gSummary = targetStats.summary;
        const pityData = gSummary[gId];
        const isBeginner = gId === "Beginner";
        const newestPoolId = targetStats.pools[0]?.id;
        const hasPlaceholder = isBeginner
          ? !targetStats.history.some(
              (it: any) => it.poolId === selectedPoolId && it.rarity >= 6,
            )
          : gId?.includes("Standard") || selectedPoolId === newestPoolId;
        const allPoolItems = targetStats.history.filter(
          (it: any) => it.poolId === selectedPoolId && it.rarity >= 4,
        );
        const totalPages = getDetailedPageCount(allPoolItems, hasPlaceholder);

        if (totalPages > 1) {
          const pageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(
                `gacha:log_page:${targetUid}:${type}:${selectedPoolId}:${Math.max(0, page - 1)}`,
              )
              .setLabel("◀")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page === 0),
            new ButtonBuilder()
              .setCustomId(
                // Use a different prefix to avoid collision with prev/next buttons
                `gacha:log_page_info:${targetUid}:${type}:${selectedPoolId}:${page}`,
              )
              .setLabel(`${page + 1} / ${totalPages}`)
              .setStyle(ButtonStyle.Primary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(
                `gacha:log_page:${targetUid}:${type}:${selectedPoolId}:${Math.min(totalPages - 1, page + 1)}`,
              )
              .setLabel("▶")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page >= totalPages - 1),
          );
          components.push(pageRow);
        }
      }

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
          const userId = interaction.user.id;
          const accounts = await getAccounts(db, userId);
          if (!accounts || accounts.length === 0) {
            await interaction.reply({
              content: tr("NoAccountBound", {
                user: interaction.user.toString(),
              }),
              flags: MessageFlags.Ephemeral as any,
            });
            return;
          }

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
              content: tr("NoAccountBound", { user: targetUser.toString() }),
            });
            return;
          }

          const account = accounts[0];
          await ensureAccountBinding(account, userId, db, tr.lang);

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
          const account = accounts[0];
          await ensureAccountBinding(account, userId, db, tr.lang);

          const gameUid = account.roles?.[0]?.uid;
          if (!gameUid) {
            throw new Error("No bound character found for this account.");
          }

          const targetUid = `EF_${gameUid}`;
          console.log(`[Gacha Load] Starting merge for UID: ${targetUid}`);

          const result = await fetchAndMergeGachaLog(
            db,
            url,
            (msg) => console.log(msg),
            targetUid,
            tr.lang,
          );

          const stats = await getGachaStats(db, result.data);
          const imageBuffer = await drawGachaStats(
            result.data,
            stats,
            tr,
            "limited_char",
          );

          if (!imageBuffer || imageBuffer.length === 0) {
            console.error(`[Gacha Load] Generated image buffer is empty!`);
            throw new Error("Generated image buffer is empty.");
          }

          console.log(
            `[Gacha Load] Sending image (${imageBuffer.length} bytes) for UID: ${targetUid}`,
          );
          const attachment = new AttachmentBuilder(imageBuffer, {
            name: "gacha_stats.png",
          });

          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`gacha:log_type:${targetUid}:${userId}`)
            .setPlaceholder(tr("gacha_log_stats_SelectPool"))
            .addOptions([
              {
                label: tr("gacha_log_stats_CharPool"),
                value: "char",
                default: true,
              },
              {
                label: tr("gacha_log_stats_WeaponPool"),
                value: "weapon",
              },
            ]);

          await interaction.editReply({
            content: "",
            files: [attachment],
            components: [
              new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                selectMenu,
              ),
            ],
          });
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
