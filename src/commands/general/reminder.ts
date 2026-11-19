import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../../interfaces/Command";
import { reminderWizard } from "../../utils/reminderWizard";
import {
  LIST_PREFIX,
  reminderList,
  reminderListComponent,
} from "../../utils/reminderList";

const command: Command = {
  data: new SlashCommandBuilder().setName("reminder").setDescription("Configure sanity and daily activity reminders")
    .setNameLocalizations({ "zh-TW": "提醒" }).setDescriptionLocalizations({ "zh-TW": "設定各帳號角色的理智與每日任務提醒" })
    .addSubcommand((sub) => sub.setName("setup").setNameLocalizations({ "zh-TW": "設定" })
      .setDescription("Set up reminders for an account and role")
      .setDescriptionLocalizations({ "zh-TW": "設定各帳號角色的提醒" }))
    .addSubcommand((sub) => sub.setName("list").setNameLocalizations({ "zh-TW": "列表" })
      .setDescription("List, pause or delete your reminder rules")
      .setDescriptionLocalizations({ "zh-TW": "列出、暫停或刪除你的提醒規則" })),
  execute: async (client, interaction, tr) => {
    const customId = (interaction as any).customId as string | undefined;
    // Components and modals: the list screen has its own customId namespace; everything else belongs to the wizard.
    if (customId !== undefined) {
      if (customId.startsWith(LIST_PREFIX)) return reminderListComponent(client, interaction, tr);
      return reminderWizard(client, interaction, tr.lang);
    }
    if (interaction.isChatInputCommand() && interaction.options.getSubcommand(false) === "list")
      return reminderList(client, interaction, tr);
    return reminderWizard(client, interaction, tr.lang);
  },
};
export default command;
