import {
  SlashCommandBuilder,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { getWikiCatalog, getWikiItemDetail } from "../../utils/skportApi";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("wiki")
    .setDescription("Search Endfield Wiki")
    .setDescriptionLocalizations({
      "zh-TW": "查詢 Endfield Wiki",
    })
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Name of the item to search (Empty for Menu Mode)")
        .setDescriptionLocalizations({ "zh-TW": "搜尋名稱 (留空進入選單模式)" })
        .setRequired(false),
    ),

  execute: async (client, interaction, tr, db) => {
    if (!interaction.isChatInputCommand()) return;

    await interaction.deferReply();

    const query = interaction.options.getString("query", false)?.toLowerCase();

    // --- Search Mode ---
    if (query) {
      try {
        const catalogData = await getWikiCatalog(interaction.locale);

        if (!catalogData || catalogData.code !== 0 || !catalogData.data) {
          return interaction.editReply({ content: "無法獲取 Wiki 目錄。" });
        }

        const mainCats = catalogData.data.catalog || [];
        const matches: any[] = [];

        // Search in Categories (Main and Sub) since we can't easily search items without scraping everything
        for (const main of mainCats) {
          if (main.name.toLowerCase().includes(query)) {
            matches.push({ ...main, type: "Category", parent: null });
          }
          if (main.typeSub) {
            for (const sub of main.typeSub) {
              if (sub.name.toLowerCase().includes(query)) {
                matches.push({
                  ...sub,
                  type: "SubCategory",
                  parent: main.name,
                });
              }
            }
          }
        }

        if (matches.length === 0) {
          return interaction.editReply({
            content: `找不到名為 "${query}" 的分類。請嘗試使用選單瀏覽。`,
          });
        }

        const container = new ContainerBuilder();
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 搜尋結果 (分類)`),
        );
        const list = matches
          .map((m) => `- ${m.parent ? `${m.parent} > ` : ""}${m.name}`)
          .join("\n");
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(list),
        );
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `\n目前僅支援搜尋分類名稱。如需搜尋物品，請使用選單功能。`,
          ),
        );

        return interaction.editReply({
          content: "",
          flags: MessageFlags.IsComponentsV2 as any,
          components: [container],
        });
      } catch (error) {
        console.error("Error in wiki search:", error);
        return interaction.editReply({ content: "搜尋時發生錯誤。" });
      }
    }

    // --- Browse Mode (Menu) ---
    try {
      const catalogData = await getWikiCatalog(interaction.locale);
      if (!catalogData || catalogData.code !== 0 || !catalogData.data) {
        return interaction.editReply({ content: "無法獲取 Wiki 目錄。" });
      }

      const mainCats = catalogData.data.catalog || [];

      // Initial State
      let currentMainId: string | null = null;
      let currentSubId: string | null = null;
      let currentItems: any[] = [];
      let currentPage = 0;

      const generateMainMenu = () => {
        const options = mainCats.map((c: any) => ({
          label: c.name,
          value: c.id,
          description: `ID: ${c.id}`,
        }));

        const menu = new StringSelectMenuBuilder()
          .setCustomId("wiki_main_select")
          .setPlaceholder("選擇主分類")
          .addOptions(options);

        return [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
        ];
      };

      const container = new ContainerBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# Endfield Wiki 目錄"),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("請選擇一個主分類開始瀏覽："),
        );

      const message = await interaction.editReply({
        content: "",
        flags: MessageFlags.IsComponentsV2 as any,
        components: [container, ...generateMainMenu()],
      });

      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 300000, // 5 mins
      });

      // Also collect buttons for Back/Pagination
      const btnCollector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 300000,
      });

      // Handlers
      const updateView = async (i: any) => {
        const components: any[] = [];
        const newContainer = new ContainerBuilder();

        if (!currentMainId) {
          // Main Menu
          newContainer.addTextDisplayComponents(
            new TextDisplayBuilder().setContent("# Endfield Wiki 目錄"),
          );
          newContainer.addTextDisplayComponents(
            new TextDisplayBuilder().setContent("請選擇一個主分類："),
          );
          components.push(...generateMainMenu());
        } else if (!currentSubId) {
          // Sub Menu
          const mainCat = mainCats.find((c: any) => c.id === currentMainId);
          if (!mainCat) {
            await i.reply({ content: "找不到主分類。", ephemeral: true });
            return;
          }

          newContainer.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`# ${mainCat.name}`),
          );
          newContainer.addTextDisplayComponents(
            new TextDisplayBuilder().setContent("請選擇一個子分類："),
          );

          const subs = mainCat.typeSub || [];
          const options = subs.map((c: any) => ({
            label: c.name,
            value: c.id,
            description: `ID: ${c.id}`,
          }));

          const menu = new StringSelectMenuBuilder()
            .setCustomId("wiki_sub_select")
            .setPlaceholder("選擇子分類")
            .addOptions(options);

          const row =
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
          const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("wiki_back")
              .setLabel("返回")
              .setStyle(ButtonStyle.Secondary),
          );

          components.push(row, btnRow);
        } else {
          // Item Menu
          const mainCat = mainCats.find((c: any) => c.id === currentMainId);
          if (!mainCat) {
            await i.reply({ content: "找不到主分類。", ephemeral: true });
            return;
          }

          const subCat = mainCat.typeSub?.find(
            (c: any) => c.id === currentSubId,
          );

          if (!subCat) {
            await i.reply({ content: "找不到子分類。", ephemeral: true });
            return;
          }

          newContainer.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`# ${subCat.name}`),
          );

          if (currentItems.length === 0) {
            newContainer.addTextDisplayComponents(
              new TextDisplayBuilder().setContent("此分類暫無項目。"),
            );
            const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("wiki_back")
                .setLabel("返回")
                .setStyle(ButtonStyle.Secondary),
            );
            components.push(btnRow);
          } else {
            newContainer.addTextDisplayComponents(
              new TextDisplayBuilder().setContent("請選擇一個項目查看詳情："),
            );

            // Pagination
            const ITEMS_PER_PAGE = 25;
            const start = currentPage * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const pageItems = currentItems.slice(start, end);

            const options = pageItems.map((item: any) => ({
              label: item.name,
              value: (item.itemId || item.id).toString(), // API uses itemId in items list
              description:
                item.brief?.description?.substring(0, 50) ||
                `ID: ${item.itemId || item.id}`,
            }));

            const menu = new StringSelectMenuBuilder()
              .setCustomId("wiki_item_select")
              .setPlaceholder(
                `選擇項目 (${start + 1}-${Math.min(end, currentItems.length)} / ${currentItems.length})`,
              )
              .addOptions(options);

            components.push(
              new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                menu,
              ),
            );

            // Nav Buttons
            const navRow = new ActionRowBuilder<ButtonBuilder>();
            navRow.addComponents(
              new ButtonBuilder()
                .setCustomId("wiki_back")
                .setLabel("返回分類")
                .setStyle(ButtonStyle.Secondary),
            );

            if (currentPage > 0) {
              navRow.addComponents(
                new ButtonBuilder()
                  .setCustomId("wiki_prev")
                  .setLabel("上一頁")
                  .setStyle(ButtonStyle.Primary),
              );
            }
            if (end < currentItems.length) {
              navRow.addComponents(
                new ButtonBuilder()
                  .setCustomId("wiki_next")
                  .setLabel("下一頁")
                  .setStyle(ButtonStyle.Primary),
              );
            }
            components.push(navRow);
          }
        }

        await i.update({
          content: "",
          flags: MessageFlags.IsComponentsV2 as any,
          components: [newContainer, ...components],
        });
      };

      collector.on("collect", async (i) => {
        if (i.user.id !== interaction.user.id) {
          await i.reply({ content: "這不是你的選單。", ephemeral: true });
          return;
        }

        try {
          if (i.customId === "wiki_main_select") {
            currentMainId = i.values[0];
            currentSubId = null;
            await updateView(i);
          } else if (i.customId === "wiki_sub_select") {
            currentSubId = i.values[0];
            currentPage = 0;
            // Fetch items
            const res = await getWikiCatalog(
              interaction.locale,
              currentMainId!.toString(),
              currentSubId!.toString(),
            );
            if (res && res.data && res.data.catalog) {
              // Traverse to find items
              const m = res.data.catalog.find(
                (c: any) => c.id == currentMainId,
              );
              const s = m?.typeSub?.find((c: any) => c.id == currentSubId);
              currentItems = s?.items || [];
            } else {
              currentItems = [];
            }
            await updateView(i);
          } else if (i.customId === "wiki_item_select") {
            const itemId = i.values[0];
            const detailData = await getWikiItemDetail(
              itemId,
              interaction.locale,
            );

            if (detailData && detailData.code === 0) {
              const info = detailData.data;
              const detailContainer = new ContainerBuilder();
              // Header
              detailContainer.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`# ${info.name}`),
              );
              detailContainer.addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(2),
              );

              // Description
              let description = info.intro || info.desc || "";
              if (!description && info.caption && Array.isArray(info.caption)) {
                description = info.caption
                  .filter((c: any) => c.kind === "text")
                  .map((c: any) => c.text?.text)
                  .join("\n\n");
              }
              if (description) {
                detailContainer.addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(description),
                );
              }

              // Image
              const imgUrl =
                info.brief?.cover || info.pic || info.image || info.icon;
              if (imgUrl) {
                const gallery = new MediaGalleryBuilder();
                gallery.addItems(
                  new MediaGalleryItemBuilder({ media: { url: imgUrl } }),
                );
                detailContainer.addMediaGalleryComponents(gallery);
              }

              // Link
              const mainId = info.typeMainId || "1"; // Fallback
              const subId = info.typeSubId || "1";
              const entryId = info.itemId || info.id;
              const link = `https://wiki.skport.com/endfield/detail?mainTypeId=${mainId}&subTypeId=${subId}&gameEntryId=${entryId}`;
              detailContainer.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `[查看 Wiki 頁面](${link})`,
                ),
              );

              // Re-render Item Menu (same as updateView logic basically, but with new container)
              const ITEMS_PER_PAGE = 25;
              const start = currentPage * ITEMS_PER_PAGE;
              const end = start + ITEMS_PER_PAGE;
              const pageItems = currentItems.slice(start, end);

              // Mark selected item
              const options = pageItems.map((item: any) => ({
                label: item.name,
                value: (item.itemId || item.id).toString(),
                description:
                  item.brief?.description?.substring(0, 50) ||
                  `ID: ${item.itemId || item.id}`,
                default: (item.itemId || item.id) == itemId,
              }));

              const menu = new StringSelectMenuBuilder()
                .setCustomId("wiki_item_select")
                .setPlaceholder("選擇項目")
                .addOptions(options);

              const navRow = new ActionRowBuilder<ButtonBuilder>();
              navRow.addComponents(
                new ButtonBuilder()
                  .setCustomId("wiki_back")
                  .setLabel("返回分類")
                  .setStyle(ButtonStyle.Secondary),
              );
              if (currentPage > 0)
                navRow.addComponents(
                  new ButtonBuilder()
                    .setCustomId("wiki_prev")
                    .setLabel("上一頁")
                    .setStyle(ButtonStyle.Primary),
                );
              if (end < currentItems.length)
                navRow.addComponents(
                  new ButtonBuilder()
                    .setCustomId("wiki_next")
                    .setLabel("下一頁")
                    .setStyle(ButtonStyle.Primary),
                );

              await i.update({
                content: "",
                flags: MessageFlags.IsComponentsV2 as any,
                components: [
                  detailContainer,
                  new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    menu,
                  ),
                  navRow,
                ],
              });
            } else {
              await i.reply({
                content: "無法獲取項目詳情。",
                ephemeral: true,
              });
            }
          }
        } catch (err) {
          console.error("Interaction error: ", err);
          // Try to edit if reply fails
          if (!i.replied && !i.deferred) {
            await i.reply({ content: "發生錯誤。", ephemeral: true });
          }
        }
      });

      btnCollector.on("collect", async (i) => {
        if (i.user.id !== interaction.user.id) {
          await i.reply({ content: "這不是你的選單。", ephemeral: true });
          return;
        }

        try {
          if (i.customId === "wiki_back") {
            if (currentSubId) {
              // Back from Items -> Sub Categories
              currentSubId = null;
              currentItems = [];
            } else if (currentMainId) {
              // Back from Sub -> Main Categories
              currentMainId = null;
            }
            await updateView(i);
          } else if (i.customId === "wiki_next") {
            currentPage++;
            await updateView(i);
          } else if (i.customId === "wiki_prev") {
            currentPage--;
            await updateView(i);
          }
        } catch (err) {
          console.error("Button interaction error: ", err);
          if (!i.replied && !i.deferred) {
            await i.reply({ content: "發生錯誤。", ephemeral: true });
          }
        }
      });
    } catch (error) {
      console.error("Error in wiki command:", error);
      await interaction.editReply({
        content: "獲取 Wiki 資訊時發生錯誤。",
      });
    }
  },
};

export default command;
