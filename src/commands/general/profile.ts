import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  ModalSubmitInteraction,
  SeparatorBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import {
  getGamePlayerBinding,
  getCardDetail,
  CardDetailResponse,
  CardChar,
} from "../../utils/skportApi";
import { CustomDatabase } from "../../utils/Database";
import { drawDashboard, drawCharacterDetail } from "../../utils/canvasUtils";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View Endfield User Profile")
    .setNameLocalizations({
      "zh-TW": "個人名片",
    })
    .setDescriptionLocalizations({
      "zh-TW": "查看終末地遊戲角色名片與幹員資訊",
    }),

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    if (!interaction.isChatInputCommand()) return;

    await interaction.deferReply({ flags: 1 << 15 });

    const userId = interaction.user.id;
    const accounts = (await db.get(`${userId}.accounts`)) as any[];

    if (!accounts || accounts.length === 0) {
      const container = new ContainerBuilder();
      const textDisplay = new TextDisplayBuilder().setContent(
        "❌ **未找到綁定帳號**\n請先使用 `/set-cookie` 綁定您的終末地帳號。",
      );
      container.addTextDisplayComponents(textDisplay);

      await interaction.editReply({
        content: "",
        flags: MessageFlags.IsComponentsV2,
        components: [container],
      });
      return;
    }

    // For simplicity, we use the first account found
    const account = accounts[0];
    const bindings = await getGamePlayerBinding(
      account.cookie,
      interaction.locale,
      account.cred,
    );

    if (!bindings) {
      await interaction.editReply("❌ **無法獲取遊戲綁定資訊**");
      return;
    }

    const endfieldApp = bindings.find((b) => b.appCode === "endfield");
    if (!endfieldApp || endfieldApp.bindingList.length === 0) {
      await interaction.editReply("⚠️ **未找到任何終末地角色**");
      return;
    }

    const binding = endfieldApp.bindingList[0];
    const role = binding.roles[0];
    if (!role) {
      await interaction.editReply("⚠️ **未找到任何角色角色**");
      return;
    }

    // Fetch Card Detail
    const cardRes: CardDetailResponse | null = await getCardDetail(
      role.roleId,
      role.serverId,
      account.info?.id || binding.uid,
      interaction.locale,
      account.cred,
    );

    if (!cardRes || cardRes.code !== 0 || !cardRes.data?.detail) {
      await interaction.editReply("⚠️ **無法取得角色詳情**");
      return;
    }

    const detail = cardRes.data.detail;

    // Generate Dashboard Canvas
    const buffer = await drawDashboard(detail);
    const attachment = new AttachmentBuilder(buffer, { name: "card.png" });

    // Create Select Menu for characters
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("card_char_select")
      .setPlaceholder("選擇想要展示詳細的幹員")
      .addOptions(
        detail.chars.slice(0, 25).map((char) => ({
          label: char.charData.name,
          description: `Lv.${char.level} | ${char.charData.profession?.value || ""}`,
          value: char.id,
        })),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      selectMenu,
    );

    const message = await interaction.editReply({
      files: [attachment],
      components: [row],
    });

    // Handle Select Menu Interaction
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 600000, // 10 minutes
    });

    collector.on("collect", async (i) => {
      const charId = i.values[0];
      const selectedChar = detail.chars.find((c) => c.id === charId);

      if (!selectedChar) {
        await i.update({ content: "⚠️ 未找到該幹員資訊", components: [row] });
        return;
      }

      await i.deferUpdate();

      try {
        const buffer = await drawCharacterDetail(selectedChar);
        const attachment = new AttachmentBuilder(buffer, {
          name: "char_detail.png",
        });

        await i.editReply({
          content: "",
          files: [attachment],
          components: [row],
        });
      } catch (e) {
        console.error("Error generating character detail:", e);
        await i.editReply({ content: "⚠️ 生成圖片失敗", components: [row] });
      }
    });
  },
};

export default command;
