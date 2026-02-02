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
      const userId = interaction.user.id;
      const accounts = (await db.get(`${userId}.accounts`)) as any[];
      const account = accounts?.[0] || {}; // Use first account for salt if exists

      const [charPoolData, weaponPoolData] = await Promise.all([
        getCharacterPool(interaction.locale, account.cred, account.salt),
        getWeaponPool(interaction.locale, account.cred, account.salt),
      ]);

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
          const charPoolHeader =
            tr("gacha_CharPool").replace("<name>", charPool.name) +
            "\n" +
            tr("gacha_Time")
              .replace("<start>", `<t:${charPool.poolStartAtTs}:f>`)
              .replace("<end>", `<t:${charPool.poolEndAtTs}:f>`);

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
          new TextDisplayBuilder().setContent(tr("gacha_CharEmpty")),
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
          const weaponPoolHeader =
            tr("gacha_WeaponPool").replace("<name>", weaponPool.name) +
            "\n" +
            tr("gacha_Time")
              .replace("<start>", `<t:${weaponPool.poolStartAtTs}:f>`)
              .replace("<end>", `<t:${weaponPool.poolEndAtTs}:f>`);

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
          new TextDisplayBuilder().setContent(tr("gacha_WeaponEmpty")),
        );
        hasData = true;
      }

      if (!hasData) {
        return interaction.editReply({
          content: tr("gacha_NoData"),
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
        content: tr("UnknownError"),
      });
    }
  },
};

export default command;
