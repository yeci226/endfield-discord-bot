import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import type { Command } from "../../interfaces/Command";
import { handleContactDevInteraction, showContactDevModal } from "../../utils/contactDev";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("contact-dev")
    .setDescription("聯絡機器人開發者") as any,
  async execute(_client: any, interaction: any) {
    if (interaction.isChatInputCommand()) {
      await showContactDevModal(interaction);
    } else {
      await handleContactDevInteraction(interaction);
    }
  },
};

export default command;
