import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import {
  getGamePlayerBinding,
  getCardDetail,
  CardDetailResponse,
} from "../../utils/skportApi";
import { CustomDatabase } from "../../utils/Database";
import { drawDashboard, drawCharacterDetail } from "../../utils/canvasUtils";
import { EnumService } from "../../services/EnumService";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View Endfield User Profile")
    .setNameLocalizations({
      "zh-TW": "個人名片",
    })
    .setDescriptionLocalizations({
      "zh-TW": "查看終末地遊戲角色名片與幹員資訊",
    })
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("View another user's profile")
        .setNameLocalizations({ "zh-TW": "使用者" })
        .setDescriptionLocalizations({ "zh-TW": "查看其他使用者的名片" }),
    )
    .addStringOption((option) =>
      option
        .setName("account")
        .setDescription("Select an account")
        .setNameLocalizations({ "zh-TW": "帳號" })
        .setDescriptionLocalizations({ "zh-TW": "選擇要查看的帳號" })
        .setAutocomplete(true),
    ),

  execute: async (
    client: ExtendedClient,
    interaction:
      | ChatInputCommandInteraction
      | ModalSubmitInteraction
      | StringSelectMenuInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    const targetUser =
      interaction.isChatInputCommand() && interaction.options.getUser("user")
        ? interaction.options.getUser("user")
        : interaction.user;

    const userId = targetUser!.id;
    const accounts = (await db.get(`${userId}.accounts`)) as any[];

    if (!accounts || accounts.length === 0) {
      const container = new ContainerBuilder();
      const textDisplay = new TextDisplayBuilder().setContent(
        targetUser?.id === interaction.user.id
          ? "❌ **未找到綁定帳號**\n請先使用 `/set-cookie` 綁定您的終末地帳號。"
          : `❌ **未找到該使用者的綁定帳號**\n使用者 <@${targetUser?.id}> 尚未綁定帳號。`,
      );
      container.addTextDisplayComponents(textDisplay);

      const replyData: any = {
        content: "",
        flags: MessageFlags.IsComponentsV2,
        components: [container],
      };

      if (interaction.isChatInputCommand()) {
        await interaction.reply({
          ...replyData,
          flags: (1 << 15) | (1 << 6),
        });
      } else {
        await interaction.editReply(replyData);
      }
      return;
    }

    // Use selected account or default to the first one
    const accountIndex = interaction.isChatInputCommand()
      ? parseInt(interaction.options.getString("account") || "0")
      : 0;
    const account = accounts[accountIndex] || accounts[0];

    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: 1 << 15 });

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
      // customId format: profile:char_select:roleId:serverId:uid
      const customId = `profile:char_select:${role.roleId}:${role.serverId}:${account.info?.id || binding.uid}`;

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(customId)
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

      await interaction.editReply({
        files: [attachment],
        components: [row],
      });
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split(":");
      if (parts[1] !== "char_select") return;

      const [, , roleId, serverId, uid] = parts;
      const charId = interaction.values[0];

      await interaction.deferUpdate();

      // Fetch Data again
      const cardRes: CardDetailResponse | null = await getCardDetail(
        roleId,
        serverId,
        uid,
        interaction.locale,
        account.cred,
      );

      if (!cardRes || cardRes.code !== 0 || !cardRes.data?.detail) {
        await interaction.editReply("⚠️ **無法取得角色詳情 (可能已過期)**");
        return;
      }

      const detail = cardRes.data.detail;
      const selectedChar = detail.chars.find((c) => c.id === charId);

      if (!selectedChar) {
        await interaction.editReply("⚠️ 未找到該幹員資訊");
        return;
      }

      const enumsData = await EnumService.getEnumsCached(
        db,
        account.cred,
        interaction.locale,
      );
      const equipEnums = [
        ...(enumsData?.equipProperties || []),
        ...(enumsData?.equipAbilities || []),
      ];

      try {
        const buffer = await drawCharacterDetail(selectedChar, equipEnums);
        const attachment = new AttachmentBuilder(buffer, {
          name: "char_detail.png",
        });

        // We keep the same select menu so they can switch again
        const selectMenu = StringSelectMenuBuilder.from(
          (interaction.message.components[0] as any).components[0] as any,
        );
        const row =
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            selectMenu,
          );

        await interaction.editReply({
          content: "",
          files: [attachment],
          components: [row],
        });
      } catch (e) {
        console.error("Error generating character detail:", e);
        await interaction.editReply("⚠️ 生成圖片失敗");
      }
    }
  },

  autocomplete: async (
    client: ExtendedClient,
    interaction: AutocompleteInteraction,
    db: CustomDatabase,
  ) => {
    const targetUser = interaction.options.get("user")?.value as string;
    const userId = targetUser || interaction.user.id;
    const accounts = (await db.get(`${userId}.accounts`)) as any[];

    if (!accounts || accounts.length === 0) {
      return interaction.respond([]);
    }

    const focusedValue = interaction.options.getFocused();
    const filtered = accounts
      .map((acc, index) => ({
        name: `${acc.info.nickname} (${acc.info.id})`,
        value: index.toString(),
      }))
      .filter((choice) => choice.name.includes(focusedValue));

    await interaction.respond(filtered.slice(0, 25));
  },
};

export default command;
