import {
  SlashCommandBuilder,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { getCharacterPool, getWeaponPool } from "../../utils/skportApi";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("gacha")
    .setNameLocalizations({
      "zh-TW": "卡池",
    })
    .setDescription("Display current character and weapon pools")
    .setDescriptionLocalizations({
      "zh-TW": "顯示當前的角色池以及武器池",
    }),

  execute: async (client, interaction, tr, db) => {
    if (!interaction.isChatInputCommand()) return;

    await interaction.deferReply();

    try {
      const [charPoolData, weaponPoolData] = await Promise.all([
        getCharacterPool(interaction.locale),
        getWeaponPool(interaction.locale),
      ]);

      const container = new ContainerBuilder();

      // Title
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent("# 當前卡池資訊"),
      );

      let hasData = false;

      // --- Character Pools ---
      if (
        charPoolData &&
        charPoolData.code === 0 &&
        charPoolData.data.list.length > 0
      ) {
        for (const charPool of charPoolData.data.list) {
          const charPoolHeader = `## 角色池：${charPool.name}\n-# 卡池時間: <t:${charPool.poolStartAtTs}:f> - <t:${charPool.poolEndAtTs}:f>`;

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
      } else {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "## 角色池\n目前沒有開啟的角色池。",
          ),
        );
        hasData = true; // Still show the message
      }

      // --- Weapon Pools ---
      if (
        weaponPoolData &&
        weaponPoolData.code === 0 &&
        weaponPoolData.data.list.length > 0
      ) {
        for (const weaponPool of weaponPoolData.data.list) {
          const weaponPoolHeader = `## 武器池：${weaponPool.name}\n-# 卡池時間: <t:${weaponPool.poolStartAtTs}:f> - <t:${weaponPool.poolEndAtTs}:f>`;

          container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(2),
          );
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(weaponPoolHeader),
          );

          const weaponGallery = new MediaGalleryBuilder();
          weaponPool.weapons.forEach((w: any) => {
            if (w.pic) {
              weaponGallery.addItems(
                new MediaGalleryItemBuilder({ media: { url: w.pic } }),
              );
            }
          });
          if (weaponGallery.items.length > 0) {
            container.addMediaGalleryComponents(weaponGallery);
          }
          hasData = true;
        }
      } else {
        container.addSeparatorComponents(
          new SeparatorBuilder().setDivider(true).setSpacing(2),
        );
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "## 武器池\n目前沒有開啟的武器池。",
          ),
        );
        hasData = true;
      }

      if (!hasData) {
        return interaction.editReply({
          content: "暫時沒有可用的卡池資訊。",
        });
      }

      await interaction.editReply({
        content: "",
        flags: MessageFlags.IsComponentsV2 as any,
        components: [container],
      });
    } catch (error) {
      console.error("Error in gacha command:", error);
      await interaction.editReply({
        content: "獲取卡池資訊時發生錯誤。",
      });
    }
  },
};

export default command;
