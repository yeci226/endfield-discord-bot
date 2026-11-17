import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../../interfaces/Command";
import { reminderWizard } from "../../utils/reminderWizard";

const command: Command = {
  data: new SlashCommandBuilder().setName("reminder").setDescription("Configure sanity and daily activity reminders")
    .setNameLocalizations({ "zh-TW": "提醒" }).setDescriptionLocalizations({ "zh-TW": "設定各帳號角色的理智與每日任務提醒" }),
  execute: async (client, interaction, tr) => reminderWizard(client, interaction, tr.lang),
};
export default command;
