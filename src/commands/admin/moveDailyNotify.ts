import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  EmbedBuilder,
  ModalSubmitInteraction,
  ChannelType,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { CustomDatabase } from "../../utils/Database";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("move-daily-notify")
    .setDescription("Batch move auto-daily notification channels in this guild")
    .setNameLocalizations({
      "zh-TW": "遷移通知頻道",
    })
    .setDescriptionLocalizations({
      "zh-TW": "批次遷移伺服器內所有使用者的自動簽到通知頻道",
    })
    .addChannelOption((op) =>
      op
        .setName("channel")
        .setDescription("The target channel to move notifications to")
        .setNameLocalizations({ "zh-TW": "目標頻道" })
        .setDescriptionLocalizations({ "zh-TW": "遷移後的目標頻道" })
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild,
    ) as SlashCommandBuilder,

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    _tr: any,
    db: CustomDatabase,
  ) => {
    if (!interaction.isChatInputCommand()) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetChannel = interaction.options.getChannel("channel", true);
    const guild = interaction.guild;

    if (!guild) {
      await interaction.editReply("❌ 此指令只能在伺服器中使用。");
      return;
    }

    // Get all channels in the current guild
    const guildChannels = await guild.channels.fetch();
    const guildChannelIds = new Set(guildChannels.keys());

    // Load autoDaily data using prefix
    const dailyUsers = await db.findByPrefix<any>("autoDaily.");
    let affectedCount = 0;

    for (const { id, value: config } of dailyUsers) {
      // If the user's current channelId is in this guild, move it
      if (config.channelId && guildChannelIds.has(config.channelId)) {
        if (config.channelId !== targetChannel.id) {
          config.channelId = targetChannel.id;
          await db.set(id, config);
          affectedCount++;
        }
      }
    }

    const container = new ContainerBuilder();
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `✅ **遷移完成**\n` +
          `已將 \`${affectedCount}\` 位使用者的通知頻道移動至 ${targetChannel}。`,
      ),
    );

    await interaction.editReply({
      content: "",
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [container],
    });
  },
};

export default command;
