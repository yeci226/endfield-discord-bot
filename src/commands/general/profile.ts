import { handleProfilePage, profilePayload } from "../../utils/profileView";
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
import { getPrimaryBindingRole, normalizeBindingEntries } from "../../utils/accountUtils";
import {
  ProfileTemplate,
  ProfileElement,
} from "../../interfaces/ProfileTemplate";
import { EnumService } from "../../services/EnumService";
import {
  ensureAccountBinding,
  getAccounts,
  withAutoRefresh,
} from "../../utils/accountUtils";
import { ProfileTemplateService } from "../../services/ProfileTemplateService";
import { generateToken } from "../../web/webSecurity";

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
        )
        .addSubcommand((sub) =>
          sub
            .setName("reset")
            .setDescription("Reset profile template to default")
            .setNameLocalizations({ "zh-TW": "重設面版" })
            .setDescriptionLocalizations({
              "zh-TW": "清除自訂面版，恢復為預設繪製",
            }),
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
    // 1. Pre-emptive defer to avoid "Unknown Interaction" (3s limit)
    if (interaction.isChatInputCommand()) {
      const subcommand = interaction.options.getSubcommand(false);
      // Config commands are ephemeral by default
      const group = interaction.options.getSubcommandGroup(false);
      const isEphemeral = group === "config" || subcommand === "edit";

      await interaction
        .deferReply({
          flags: (isEphemeral ? MessageFlags.Ephemeral : 1 << 15) as any,
        })
        .catch(() => {});
    } else if (interaction.isStringSelectMenu() || interaction.isButton()) {
      await interaction.deferUpdate().catch(() => {});
    }

    const interactionAny = interaction as any;
    let targetUser = interactionAny.user;
    let accountIndex = 0;
    let isConfig = false;

    if (interaction.isStringSelectMenu() || interaction.isButton()) {
      await handleProfilePage(client, interaction, tr);
      return;
    }

    // 3. Handle Chat Input Commands
    if (interaction.isChatInputCommand()) {
      const group = interaction.options.getSubcommandGroup(false);
      const subcommand = interaction.options.getSubcommand(false);

      if (group === "config") {
        isConfig = true;
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
          await interaction.editReply({
            content: tr("profile_Config_Success"),
            flags: MessageFlags.Ephemeral as any,
          });
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
          // Clear stored custom template so drawDashboard falls back to default canvas
          await db.delete(`profile.${userId}.template`);
          await interaction.editReply(tr("profile_Config_Success"));
          return;
        }
      }

      if (subcommand === "edit") {
        const userId = interaction.user.id;
        const accounts = await getAccounts(db, userId);

        if (!accounts || accounts.length === 0) {
          await interaction.editReply(tr("NoSetAccount"));
          return;
        }

        // Unguessable token (192 bits of CSPRNG output)
        const token = generateToken();

        // Save token to DB with expiry (e.g. 30 mins)
        await db.set(`profile_edit_token:${token}`, {
          userId,
          expiresAt: Date.now() + 30 * 60 * 1000,
        });

        const baseUrl =
          process.env.EDITOR_PUBLIC_URL || "http://localhost:3838";
        const editUrl = `${baseUrl}/profile/edit?token=${token}`;

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel(tr("profile_Editor_Button"))
            .setStyle(ButtonStyle.Link)
            .setURL(editUrl),
        );

        await interaction.editReply({
          content: tr("profile_Editor_WebLinkDesc"),
          components: [row],
        });
        return;
      }

      if (subcommand === "view") {
        targetUser = interaction.options.getUser("user") || interaction.user;
        accountIndex = parseInt(
          interaction.options.getString("account") || "0",
        );
      }
    }

    // 4. Main Profile View Logic (for ChatInput)
    const targetUserId = targetUser.id;
    const accounts = await getAccounts(db, targetUserId);

    if (!accounts || accounts.length === 0) {
      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          targetUserId === interaction.user.id
            ? tr("NoSetAccount")
            : tr("AccountNotFoundUser", { targetUser: `<@${targetUserId}>` }),
        ),
      );

      if (!(interaction.deferred && (interaction as any).ephemeral)) {
        try {
          await interaction.deleteReply().catch(() => {});
        } catch {}
        await interaction.followUp({
          content: "",
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [container],
        });
      } else {
        await interaction.editReply({
          content: "",
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [container],
        });
      }
      return;
    }

    const account = accounts[accountIndex] || accounts[0];
    await ensureAccountBinding(account, targetUserId, db, tr.lang);

    if (!account.roles || account.roles.length === 0) {
      // If we deferred with a public flag but want an ephemeral error, we must delete and followUp
      if (!(interaction.deferred && (interaction as any).ephemeral)) {
        try {
          await interaction.deleteReply();
        } catch {}
        await interaction.followUp({
          content: tr("BindingNotFound"),
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.editReply({
          content: tr("BindingNotFound"),
        });
      }
      return;
    }

    const primaryBinding = getPrimaryBindingRole(normalizeBindingEntries(account.roles).filter((binding) => Number(binding.gameId) === 3));
    const role = primaryBinding?.role;
    const uid = primaryBinding?.binding?.uid || account.info?.id;

    if (!role) {
      if (!(interaction.deferred && (interaction as any).ephemeral)) {
        try {
          await interaction.deleteReply();
        } catch {}
        await interaction.followUp({
          content: tr("daily_RoleNotFound"),
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.editReply({
          content: tr("daily_RoleNotFound"),
        });
      }
      return;
    }

    let cardRes: any;
    try {
      cardRes = await withAutoRefresh(
        client,
        targetUserId,
        account,
        (c: string, s: string, options: any) =>
          getCardDetail(
            role.roleId,
            role.serverId,
            account.info?.id || uid,
            tr.lang,
            c,
            s,
            options,
          ),
        tr.lang,
      );
    } catch (e: any) {
      if (e.message === "TokenExpired") {
        cardRes = { code: 10000, message: "TokenExpired" };
      } else {
        throw e;
      }
    }

    if (!cardRes || cardRes.code !== 0 || !cardRes.data?.detail) {
      console.error("[Profile] API failed or returned error (main):", cardRes);
      const errorMsg =
        cardRes?.code === 10000
          ? tr("TokenExpired")
          : `${tr("Error")} (API Code: ${cardRes?.code ?? "NULL"}, Status: ${cardRes?.status ?? "NULL"})`;
      if (!(interaction.deferred && (interaction as any).ephemeral)) {
        try {
          await interaction.deleteReply();
        } catch {}
        await interaction.followUp({
          content: errorMsg,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.editReply({
          content: errorMsg,
        });
      }
      return;
    }

    const payload = await profilePayload(client, {
      ownerId: targetUserId, uid: String(account.info?.id || uid),
      roleId: String(role.roleId), serverId: String(role.serverId),
    }, cardRes.data.detail, tr);
    await interaction.editReply(payload);

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
    const seenIds = new Set<string>();
    const filtered = accounts
      .map((acc: any, index: number) => {
        const id = acc.info?.id ?? acc.info?.uid ?? String(index);
        if (seenIds.has(id)) return null;
        seenIds.add(id);
        return {
          name: `${acc.info?.nickname ?? "Unknown"} (${id})`,
          value: index.toString(),
        };
      })
      .filter(
        (choice): choice is { name: string; value: string } =>
          choice !== null &&
          choice.name.toLowerCase().includes(focusedValue.toLowerCase()),
      );

    await interaction.respond(filtered.slice(0, 25));
  },
};

export default command;
