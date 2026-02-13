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
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ComponentType,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { getCardDetail, CardDetailResponse } from "../../utils/skportApi";
import { CustomDatabase } from "../../utils/Database";
import { drawDashboard, drawCharacterDetail } from "../../utils/canvasUtils";
import {
  ProfileTemplate,
  ProfileElement,
} from "../../interfaces/ProfileTemplate";
import { EnumService } from "../../services/EnumService";
import { ensureAccountBinding, getAccounts } from "../../utils/accountUtils";
import { ProfileTemplateService } from "../../services/ProfileTemplateService";

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
    .addSubcommand((sub) =>
      sub
        .setName("view")
        .setDescription("View user profile")
        .setNameLocalizations({ "zh-TW": "查看" })
        .setDescriptionLocalizations({ "zh-TW": "查看使用者名片" })
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
    )
    .addSubcommandGroup((group) =>
      group
        .setName("config")
        .setDescription("Custom Profile Configuration")
        .setNameLocalizations({ "zh-TW": "設定" })
        .setDescriptionLocalizations({ "zh-TW": "個人名片客製化設定" })
        .addSubcommand((sub) =>
          sub
            .setName("template")
            .setDescription("Apply a shared template UUID")
            .setNameLocalizations({ "zh-TW": "套用面版" })
            .setDescriptionLocalizations({ "zh-TW": "套用分享的 UUID 面版" })
            .addStringOption((opt) =>
              opt
                .setName("uuid")
                .setDescription("Template UUID")
                .setNameLocalizations({ "zh-TW": "uuid" })
                .setRequired(true),
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Interactive Profile Editor")
        .setNameLocalizations({ "zh-TW": "編輯" })
        .setDescriptionLocalizations({ "zh-TW": "開啟互動式個人名片編輯器" }),
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
    const interactionAny = interaction as any;
    let targetUser = interactionAny.user;
    let accountIndex = 0;
    let isConfig = false;

    if (interaction.isChatInputCommand()) {
      const group = interaction.options.getSubcommandGroup(false);
      const subcommand = interaction.options.getSubcommand(false);

      if (group === "config") {
        isConfig = true;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const userId = interaction.user.id;

        if (subcommand === "template") {
          const uuid = interaction.options.getString("uuid", true);
          const template = await ProfileTemplateService.getTemplateById(
            db,
            uuid,
          );
          if (!template) {
            await interaction.editReply(tr("profile_Config_InvalidUUID"));
            return;
          }
          await ProfileTemplateService.saveUserTemplate(db, userId, template);
          await interaction.editReply(tr("profile_Config_Success"));
          return;
        }

        if (subcommand === "background") {
          const url = interaction.options.getString("url", true);
          await ProfileTemplateService.updateBackground(db, userId, url);
          await interaction.editReply(tr("profile_Config_Success"));
          return;
        }

        if (subcommand === "toggle") {
          const element = interaction.options.getString("element", true) as any;
          await ProfileTemplateService.toggleElement(db, userId, element);
          await interaction.editReply(tr("profile_Config_Success"));
          return;
        }

        if (subcommand === "share") {
          const template = await ProfileTemplateService.getUserTemplate(
            db,
            userId,
          );
          const uuid = await ProfileTemplateService.shareTemplate(
            db,
            template,
            userId,
          );
          await interaction.editReply(
            tr("profile_Config_ShareSuccess", { uuid }),
          );
          return;
        }

        if (subcommand === "reset") {
          const def = ProfileTemplateService.getDefaultTemplate();
          await ProfileTemplateService.saveUserTemplate(db, userId, def);
          await interaction.editReply(tr("profile_Config_Success"));
          return;
        }
      } else if (subcommand === "edit") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const userId = interaction.user.id;
        const accounts = await getAccounts(db, userId);

        if (!accounts || accounts.length === 0) {
          await interaction.editReply(tr("NoSetAccount"));
          return;
        }

        // Generate a random token for the session
        const token =
          Math.random().toString(36).substring(2, 15) +
          Math.random().toString(36).substring(2, 15);

        // Save token to DB with expiry (e.g. 15 mins)
        await db.set(`profile_edit_token:${token}`, {
          userId,
          expiresAt: Date.now() + 15 * 60 * 1000,
        });

        const baseUrl =
          process.env.EDITOR_PUBLIC_URL?.replace("/endfield", "") ||
          "http://localhost:3838";
        const editUrl = `${baseUrl}/profile/edit?token=${token}`;

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel("開啟網頁編輯器 Open Editor")
            .setStyle(ButtonStyle.Link)
            .setURL(editUrl),
        );

        await interaction.editReply({
          content: tr("profile_Editor_WebLinkDesc"),
          components: [row],
        });
        return;
      } else if (subcommand === "view") {
        targetUser = interaction.options.getUser("user") || interaction.user;
        accountIndex = parseInt(
          interaction.options.getString("account") || "0",
        );
      }
    }

    const userId = targetUser.id;
    const accounts = await getAccounts(db, userId);

    if (!accounts || accounts.length === 0) {
      const container = new ContainerBuilder();
      const textDisplay = new TextDisplayBuilder().setContent(
        targetUser.id === interaction.user.id
          ? tr("NoSetAccount")
          : tr("AccountNotFoundUser", {
              targetUser: `<@${targetUser.id}>`,
            }),
      );
      container.addTextDisplayComponents(textDisplay);

      const replyData: any = {
        content: "",
        flags: MessageFlags.IsComponentsV2,
        components: [container],
      };

      if (interactionAny.isChatInputCommand()) {
        await interactionAny.reply({
          ...replyData,
          flags: (1 << 15) | (1 << 6),
        });
      } else if (interactionAny.isStringSelectMenu()) {
        await interactionAny.update(replyData);
      } else {
        await interactionAny.reply({
          ...replyData,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    // Use selected account or default to the first one
    const account = accounts[accountIndex] || accounts[0];

    if (interaction.isChatInputCommand() && !isConfig) {
      await interaction.deferReply({ flags: 1 << 15 });

      // AUTO-MIGRATION & REBIND LOGIC
      // Use shared utility to ensure roles and credentials are valid
      await ensureAccountBinding(account, userId, db, tr.lang);

      // Use stored roles
      const roles = account.roles;

      if (!roles || roles.length === 0) {
        await interaction.editReply(tr("BindingNotFound"));
        return;
      }

      const role = roles[0]?.roles?.[0];
      if (!role) {
        await interaction.editReply(tr("daily_RoleNotFound"));
        return;
      }

      const uid = roles[0].uid || account.info?.id;

      // Fetch Card Detail
      const cardRes: CardDetailResponse | null = await getCardDetail(
        role.roleId,
        role.serverId,
        account.info?.id || uid,
        tr.lang,
        account.cred,
        account.salt,
      );

      if (!cardRes || cardRes.code !== 0 || !cardRes.data?.detail) {
        await interaction.editReply(tr("Error"));
        return;
      }

      const detail = cardRes.data.detail;

      // Get Profile Owner's Template
      const template = await ProfileTemplateService.getUserTemplate(db, userId);

      // Generate Buffer via Canvas
      const buffer = await drawDashboard(detail, tr, template);
      // const buffer = await drawDashboard(detail, tr);
      const attachment = new AttachmentBuilder(buffer, { name: "card.png" });

      // Create Select Menu for characters
      // customId format: profile:char_select:roleId:serverId:uid:ownerId
      const customId = `profile:char_select:${role.roleId}:${role.serverId}:${account.info?.id || uid}:${userId}`;

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

      const [, , roleId, serverId, uid, ownerId] = parts;
      const charId = interaction.values[0];

      if (charId === "home") {
        // Fetch Data again
        const cardRes: CardDetailResponse | null = await getCardDetail(
          roleId,
          serverId,
          uid,
          tr.lang,
          account.cred,
          account.salt,
        );

        if (!cardRes || cardRes.code !== 0 || !cardRes.data?.detail) {
          await interaction.editReply(tr("UnknownError"));
          return;
        }

        const detail = cardRes.data.detail;
        const template = await ProfileTemplateService.getUserTemplate(
          db,
          ownerId || userId,
        );
        // const buffer = await drawDashboard(detail, tr, template);
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
        account.salt,
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
        account.salt,
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
    const accounts = await getAccounts(db, userId);

    if (!accounts || accounts.length === 0) {
      return interaction.respond([]);
    }

    const focusedValue = interaction.options.getFocused();
    const filtered = accounts
      .map((acc: any, index: number) => ({
        name: `${acc.info.nickname} (${acc.info.id})`,
        value: index.toString(),
      }))
      .filter((choice: any) => choice.name.includes(focusedValue));

    await interaction.respond(filtered.slice(0, 25));
  },
};

export default command;
