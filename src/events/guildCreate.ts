import { Events, WebhookClient, EmbedBuilder } from "discord.js";
import { Event } from "../interfaces/Event";
import moment from "moment";

const webhook = process.env.JLWEBHOOK
  ? new WebhookClient({ url: process.env.JLWEBHOOK })
  : null;

const event: Event = {
  name: Events.GuildCreate,
  execute: async (client, guild) => {
    const totalGuilds = client.guilds.cache.size;

    if (webhook) {
      webhook.send({
        embeds: [
          new EmbedBuilder()
            .setColor(guild.memberCount > 100 ? "#FFFF80" : "#57F287")
            .setThumbnail(guild.iconURL() || null)
            .setTitle("新的伺服器出現了")
            .addFields({
              name: "名稱",
              value: `\`${guild.name}\``,
              inline: false,
            })
            .addFields({
              name: "ID",
              value: `\`${guild.id}\``,
              inline: false,
            })
            .addFields({
              name: "擁有者",
              value: `<@${guild.ownerId}>`,
              inline: false,
            })
            .addFields({
              name: "人數",
              value: `\`${guild.memberCount}\` 個成員`,
              inline: false,
            })
            .addFields({
              name: "建立時間",
              value: `<t:${moment(guild.createdAt).unix()}:F>`,
              inline: false,
            })
            .addFields({
              name: `${client.user!.username} 的伺服器數量`,
              value: `\`${totalGuilds}\` 個伺服器`,
              inline: false,
            })
            .setTimestamp(),
        ],
      });
    }
  },
};

export default event;
