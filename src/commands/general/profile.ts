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
          ? tr("NoSetAccount")
          : tr("AccountNotFoundUser", {
              targetUser: `<@${targetUser?.id}>`,
            }),
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
      } else if (interaction.isStringSelectMenu()) {
        await interaction.update(replyData);
      } else {
        await interaction.reply({
          ...replyData,
          flags: MessageFlags.Ephemeral,
        });
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
        tr.lang,
        account.cred,
      );

      if (!bindings) {
        await interaction.editReply(tr("FetchDataFailed"));
        return;
      }

      const endfieldApp = bindings.find((b) => b.appCode === "endfield");
      if (!endfieldApp || endfieldApp.bindingList.length === 0) {
        await interaction.editReply(tr("BindingNotFound"));
        return;
      }

      const binding = endfieldApp.bindingList[0];
      const role = binding.roles[0];
      if (!role) {
        await interaction.editReply(tr("daily_RoleNotFound"));
        return;
      }

      // Fetch Card Detail
      const cardRes: CardDetailResponse | null = await getCardDetail(
        role.roleId,
        role.serverId,
        account.info?.id || binding.uid,
        tr.lang,
        account.cred,
      );

      if (!cardRes || cardRes.code !== 0 || !cardRes.data?.detail) {
        await interaction.editReply(tr("Error"));
        return;
      }

      const detail = cardRes.data.detail;

      // Generate Dashboard Canvas
      const buffer = await drawDashboard(detail, tr);
      const attachment = new AttachmentBuilder(buffer, { name: "card.png" });

      // Create Select Menu for characters
      // customId format: profile:char_select:roleId:serverId:uid
      const customId = `profile:char_select:${role.roleId}:${role.serverId}:${account.info?.id || binding.uid}`;

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(tr("profile_SelectCharacter"))
        .addOptions(
          detail.chars.slice(0, 25).map((char) => ({
            label: char.charData.name,
            description: `Lv.${char.level} | ${
              char.charData.profession?.value || ""
            }`,
            value: char.id,
          })),
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        selectMenu,
      );

      await interaction.editReply({
        content: "",
        files: [attachment],
        components: [row],
      });
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await interaction.deferUpdate();
      const parts = interaction.customId.split(":");
      if (parts[1] !== "char_select") return;

      const [, , roleId, serverId, uid] = parts;
      const charId = interaction.values[0];

      if (charId === "home") {
        // Fetch Data again
        const cardRes: CardDetailResponse | null = await getCardDetail(
          roleId,
          serverId,
          uid,
          tr.lang,
          account.cred,
        );

        if (!cardRes || cardRes.code !== 0 || !cardRes.data?.detail) {
          await interaction.editReply(tr("UnknownError"));
          return;
        }

        const detail = cardRes.data.detail;
        const buffer = await drawDashboard(detail, tr);
        const attachment = new AttachmentBuilder(buffer, { name: "card.png" });

        let selectMenu = StringSelectMenuBuilder.from(
          (interaction.message.components[0] as any).components[0] as any,
        );

        // Returning to Home: Remove the Home option if it exists
        const options = selectMenu.options.filter(
          (o) => o.data.value !== "home",
        );
        selectMenu.setOptions(
          detail.chars.slice(0, 25).map((char) => ({
            label: char.charData.name,
            description: `Lv.${char.level} | ${
              char.charData.profession?.value || ""
            }`,
            value: char.id,
          })),
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
        return;
      }

      // Fetch Data again
      const cardRes: CardDetailResponse | null = await getCardDetail(
        roleId,
        serverId,
        uid,
        tr.lang,
        account.cred,
      );

      if (!cardRes || cardRes.code !== 0 || !cardRes.data?.detail) {
        await interaction.editReply(tr("UnknownError"));
        return;
      }

      const detail = cardRes.data.detail;
      const charIndex = detail.chars.findIndex((c) => c.id === charId) + 1;
      const selectedChar = detail.chars[charIndex - 1];

      if (!selectedChar) {
        await interaction.editReply(tr("daily_RoleNotFound"));
        return;
      }

      const enumsData = await EnumService.getEnumsCached(
        db,
        account.cred,
        tr.lang,
      );
      const equipEnums = [
        ...(enumsData?.equipProperties || []),
        ...(enumsData?.equipAbilities || []),
      ];

      try {
        const buffer = await drawCharacterDetail(
          selectedChar,
          tr,
          equipEnums,
          charIndex,
        );
        const attachment = new AttachmentBuilder(buffer, {
          name: "char_detail.png",
        });

        // We need to add "Home" option if it's not present
        let selectMenu = StringSelectMenuBuilder.from(
          (interaction.message.components[0] as any).components[0] as any,
        );

        const hasHome = selectMenu.options.some((o) => o.data.value === "home");
        if (!hasHome) {
          selectMenu.setOptions([
            {
              label: "🏠 " + tr("MainPage"),
              value: "home",
            },
            ...detail.chars.slice(0, 24).map((char) => ({
              label: char.charData.name,
              description: `Lv.${char.level} | ${
                char.charData.profession?.value || ""
              }`,
              value: char.id,
            })),
          ]);
        }
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
        await interaction.editReply(tr("Error"));
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
