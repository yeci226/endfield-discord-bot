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
import { ensureAccountBinding, getAccounts } from "../../utils/accountUtils";

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
      const accounts = await getAccounts(db, userId);
      const account = accounts?.[0] || {}; // Use first account for salt if exists

      if (account.cookie) {
        await ensureAccountBinding(account, userId, db, tr.lang);
      }

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

      // No weapon pool display as requested, but we keep the API call for potential future use or consistency

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
