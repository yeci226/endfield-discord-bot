import { Events, WebhookClient, EmbedBuilder } from "discord.js";
import { Event } from "../interfaces/Event";
import { Logger } from "../utils/Logger";

const webhook = process.env.ERRWEBHOOK
  ? new WebhookClient({ url: process.env.ERRWEBHOOK })
  : null;
const logger = new Logger("系统");

const event: Event = {
  name: Events.Error,
  execute: async (client, error: Error) => {
    logger.error(`Discord Client Error: ${error.message}`);
    console.error(error);

    if (webhook) {
      try {
        const embed = new EmbedBuilder()
          .setTitle("Discord Client Error")
          .setDescription(`\`\`\`${error.stack || error.message}\`\`\``)
          .setColor("Red")
          .setTimestamp();

        await webhook.send({
          embeds: [embed],
        });
      } catch (e) {
        console.error("Failed to send error webhook", e);
      }
    }
  },
};

export default event;
