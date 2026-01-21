import {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { Command } from "../../interfaces/Command";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("news")
    .setNameLocalizations({
      "zh-TW": "新聞",
    })
    .setDescription("Manage news subscriptions")
    .setDescriptionLocalizations({
      "zh-TW": "管理新聞訂閱",
    })
    .addSubcommand((sub) =>
      sub
        .setName("bind")
        .setNameLocalizations({
          "zh-TW": "綁定",
        })
        .setDescription("Bind channels to receive news (multi-select)")
        .setDescriptionLocalizations({
          "zh-TW": "綁定頻道以接收新聞 (多選)",
        }),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unbind")
        .setNameLocalizations({
          "zh-TW": "解綁",
        })
        .setDescription("Unbind all channels from news subscriptions")
        .setDescriptionLocalizations({
          "zh-TW": "取消所有頻道的新聞綁定",
        }),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  execute: async (client, interaction, tr, db) => {
    if (!interaction.isChatInputCommand()) return;

    // 1. Permission Check (Only for Guilds)
    if (interaction.guildId) {
      const member = interaction.member;
      if (
        !member ||
        typeof member.permissions === "string" ||
        !member.permissions.has(PermissionFlagsBits.ManageGuild)
      ) {
        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "❌ 你需要 `管理伺服器` 權限才能使用此指令。",
          ),
        );
        await interaction.reply({
          flags: (1 << 15) | MessageFlags.Ephemeral,
          components: [container],
        });
        return;
      }
    }

    const subscriptions =
      ((await db.get("news_subscriptions")) as Array<{
        guildId: string;
        channelId: string;
        boundAt: number;
      }>) || [];

    const isGuild = !!interaction.guildId;
    const currentGuildId = interaction.guildId || "DM";
    const subCommand = interaction.options.getSubcommand();

    if (subCommand === "bind") {
      if (isGuild) {
        // --- GUILD: Show Channel Selector ---
        const guildSubscriptions = subscriptions.filter(
          (s) => s.guildId === currentGuildId,
        );

        const selectMenu = new ChannelSelectMenuBuilder()
          .setCustomId("notification_channel")
          .setChannelTypes([
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ])
          .setPlaceholder(
            guildSubscriptions.length > 0
              ? `目前已綁定 ${guildSubscriptions.length} 個頻道`
              : "選擇文字頻道...",
          )
          .setMinValues(0)
          .setMaxValues(25);

        const row =
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
            selectMenu,
          );

        const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("news:bind_current")
            .setLabel("綁定當前頻道")
            .setStyle(ButtonStyle.Primary)
            .setEmoji("📌"),
        );

        await interaction.reply({
          content: "請選擇要接收最新新聞通知的頻道（可多選）：",
          flags: MessageFlags.Ephemeral,
          components: [buttonRow, row],
        });
      } else {
        // --- DM: Direct Bind ---
        const existing = subscriptions.find(
          (s) => s.channelId === interaction.channelId,
        );

        const container = new ContainerBuilder();

        if (existing) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent("✅ **此私訊頻道已綁定**"),
          );
        } else {
          subscriptions.push({
            guildId: "DM",
            channelId: interaction.channelId,
            boundAt: Date.now(),
          });
          await db.set("news_subscriptions", subscriptions);

          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "✅ **成功綁定**\n將會在此私訊接收最新新聞。",
            ),
          );
        }

        await interaction.reply({
          flags: (1 << 15) | MessageFlags.Ephemeral,
          components: [container],
        });
      }
    } else if (subCommand === "unbind") {
      let newSubscriptions = [];
      let removedCount = 0;

      if (isGuild) {
        // --- GUILD: Remove all guild subscriptions ---
        newSubscriptions = subscriptions.filter(
          (s) => s.guildId !== currentGuildId,
        );
        removedCount = subscriptions.length - newSubscriptions.length;
      } else {
        // --- DM: Remove only this channel ---
        newSubscriptions = subscriptions.filter(
          (s) => s.channelId !== interaction.channelId,
        );
        removedCount = subscriptions.length - newSubscriptions.length;
      }

      await db.set("news_subscriptions", newSubscriptions);

      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent("✅ **成功解除綁定**"),
      );

      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(1),
      );

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          removedCount > 0
            ? `已解除 ${isGuild ? "本伺服器所有" : "此"} 綁定 (${removedCount} 個頻道)。`
            : "目前沒有綁定任何頻道。",
        ),
      );

      await interaction.reply({
        flags: (1 << 15) | MessageFlags.Ephemeral,
        components: [container],
      });
    }
  },
};

export default command;
