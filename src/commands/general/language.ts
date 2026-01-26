import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  ModalSubmitInteraction,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { CustomDatabase } from "../../utils/Database";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("language")
    .setDescription("Change bot language")
    .setNameLocalizations({
      "zh-TW": "語言",
    })
    .setDescriptionLocalizations({
      "zh-TW": "變更機器人語言",
    })
    .addStringOption((option) =>
      option
        .setName("lang")
        .setDescription("Select language")
        .setNameLocalizations({
          "zh-TW": "語言設定",
        })
        .setDescriptionLocalizations({
          "zh-TW": "選擇語言",
        })
        .setRequired(true)
        .addChoices(
          { name: "繁體中文", value: "tw" },
          { name: "English", value: "en" },
        ),
    ) as SlashCommandBuilder,

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    if (!interaction.isChatInputCommand()) return;
    const lang = interaction.options.getString("lang", true);
    await db.set(`${interaction.user.id}.locale`, lang);

    // Re-create translator for the response to reflect the change immediately
    const { createTranslator } = require("../../utils/i18n");
    const newTr = createTranslator(lang);

    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        newTr("NewLocale", { locale: lang === "tw" ? "繁體中文" : "English" }),
      ),
    );

    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [container],
    });
  },
};

export default command;
