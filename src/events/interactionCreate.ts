import {
  Events,
  MessageFlags,
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  WebhookClient,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Event } from "../interfaces/Event";
import { Logger } from "../utils/Logger";
import { createTranslator, toI18nLang } from "../utils/i18n";

const webhook = process.env.CMDWEBHOOK
  ? new WebhookClient({ url: process.env.CMDWEBHOOK })
  : null;
const logger = new Logger("Interaction");

const event: Event = {
  name: Events.InteractionCreate,
  execute: async (client, interaction) => {
    const userLang =
      (await client.db.get(`${interaction.user.id}.locale`)) ||
      toI18nLang(interaction.locale);
    const tr = createTranslator(userLang);

    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(client, interaction, tr, client.db);

        if (webhook) {
          webhook.send({
            embeds: [
              new EmbedBuilder()
                .setTimestamp()
                .setAuthor({
                  iconURL: interaction.user.displayAvatarURL({
                    size: 4096,
                  }),
                  name: `${interaction.user.username} - ${interaction.user.id}`,
                })
                .setThumbnail(
                  interaction.guild?.iconURL({
                    size: 4096,
                  }) || null,
                )
                .setDescription(
                  `\`\`\`${interaction.guild?.name} - ${interaction.guild?.id}\`\`\``,
                )
                .addFields({
                  name: command.data.name,
                  value: `${
                    (
                      interaction as ChatInputCommandInteraction
                    ).options.getSubcommand(false)
                      ? `> ${(interaction as ChatInputCommandInteraction).options.getSubcommand(false)}`
                      : "\u200b"
                  }`,
                  inline: true,
                }),
            ],
          });
        }
      } catch (error: any) {
        if (error.code === 10062 || error.code === 40060) {
          // Interaction expired or already handled, ignore
          return;
        }
        logger.error(
          `Command execution error: ${error.message}${error.stack ? `\n${error.stack}` : ""}`,
        );
        if (interaction.replied || interaction.deferred) {
          try {
            // If it was a public defer, delete it to hide the "Loading..." from others
            if (!(interaction as any).ephemeral) {
              await interaction.deleteReply().catch(() => {});
            }
          } catch {}
          await interaction.followUp({
            content: tr("Error"),
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: tr("Error"),
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    } else if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;
      const commandName = customId.split(":")[0];
      const command = client.commands.get(commandName);

      if (command) {
        try {
          await command.execute(client, interaction, tr, client.db);
        } catch (error: any) {
          if (error.code === 10062 || error.code === 40060) return;
          logger.error(
            `Error handling select menu interaction: ${error.message}`,
          );
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
              content: tr("Error"),
              flags: MessageFlags.Ephemeral,
            });
          } else {
            // Try to find a way to reply if not already
            try {
              await interaction.reply({
                content: tr("Error"),
                flags: MessageFlags.Ephemeral,
              });
            } catch (e) {
              // Ignore if reply failed (e.g. unknown interaction)
            }
          }
        }
      }
    } else if (interaction.isModalSubmit()) {
      // Dispatch modal submit to the relevant command.
      // Convention: customId = "commandName:..."
      // Current setCookie implementation uses "set-cookie:modal"

      const customId = interaction.customId;
      const commandName = customId.split(":")[0];
      const command = client.commands.get(commandName);

      if (command) {
        try {
          await command.execute(client, interaction, tr, client.db);
        } catch (error: any) {
          if (error.code === 10062 || error.code === 40060) return;
          console.error("Error handling modal submit:", error);
        }
      }
    } else if (interaction.isChannelSelectMenu()) {
      if (interaction.customId === "notification_channel") {
        if (!interaction.guildId || !interaction.guild) return;

        await interaction.deferUpdate();

        const selectedChannels = interaction.values;
        const validChannels: string[] = [];
        const invalidChannels: string[] = [];

        const guild = interaction.guild;

        // Validate permissions for selected channels
        for (const channelId of selectedChannels) {
          try {
            const channel = await guild.channels.fetch(channelId);
            if (!channel) continue;

            const permissions = channel.permissionsFor(client.user?.id!);
            if (!permissions) {
              invalidChannels.push(`<#${channelId}> (無法確認權限)`);
              continue;
            }

            const hasView = permissions.has(PermissionFlagsBits.ViewChannel);
            const hasSend = permissions.has(PermissionFlagsBits.SendMessages);

            if (hasView && hasSend) {
              validChannels.push(channelId);
            } else {
              const missing: string[] = [];
              if (!hasView) missing.push("檢視頻道");
              if (!hasSend) missing.push("發送訊息");
              invalidChannels.push(
                `<#${channelId}> (缺少: ${missing.join(", ")})`,
              );
            }
          } catch (e) {
            console.error(
              `Error checking permissions for channel ${channelId}:`,
              e,
            );
            invalidChannels.push(`<#${channelId}> (檢查時發生錯誤)`);
          }
        }

        // Update Database
        const subscriptions =
          ((await client.db.get("news_subscriptions")) as Array<{
            guildId: string;
            channelId: string;
            boundAt: number;
          }>) || [];

        // Remove old subscriptions for this guild
        const otherGuildSubscriptions = subscriptions.filter(
          (s) => s.guildId !== interaction.guildId,
        );

        // Add new valid subscriptions
        const newSubscriptions = [
          ...otherGuildSubscriptions,
          ...validChannels.map((channelId) => ({
            guildId: interaction.guildId!,
            channelId,
            boundAt: Date.now(),
          })),
        ];

        await client.db.set("news_subscriptions", newSubscriptions);

        // Build Confirmation Response
        const container = new ContainerBuilder();

        if (validChannels.length > 0) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `✅ **設定已更新**\n已綁定以下頻道接收通知：\n${validChannels.map((id) => `<#${id}>`).join("\n")}`,
            ),
          );
        } else if (selectedChannels.length > 0 && validChannels.length === 0) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `❌ **設定失敗**\n所有選擇的頻道皆無效，請檢查機器人權限。`,
            ),
          );
        } else {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `✅ **設定已更新**\n已取消所有頻道綁定。`,
            ),
          );
        }

        if (invalidChannels.length > 0) {
          container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(1),
          );
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `⚠️ **以下頻道無法綁定** (權限不足)：\n${invalidChannels.join("\n")}\n請確保機器人擁有「檢視頻道」和「發送訊息」權限。`,
            ),
          );
        }

        await interaction.editReply({
          content: "",
          flags: (1 << 15) | MessageFlags.Ephemeral,
          components: [container],
        });
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === "news:bind_current") {
        if (!interaction.guildId || !interaction.guild) return;

        // Defer update or reply (ephemeral)
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const channel = interaction.channel;
        if (
          !channel ||
          channel.isDMBased() ||
          !channel
            .permissionsFor(client.user?.id!)
            ?.has(PermissionFlagsBits.ViewChannel) ||
          !channel
            .permissionsFor(client.user?.id!)
            ?.has(PermissionFlagsBits.SendMessages)
        ) {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `❌ **無法綁定當前頻道**\n請確保機器人擁有「檢視頻道」和「發送訊息」權限。`,
            ),
          );
          await interaction.editReply({
            content: "",
            components: [container],
            flags: (1 << 15) | MessageFlags.Ephemeral,
          }); // Note: flags are already set in deferReply? No, editReply reuses.
          // However discord.js might require re-stating if changing to V2?
          // Actually, simply passing components usually works.
          return;
        }

        const subscriptions =
          ((await client.db.get("news_subscriptions")) as Array<{
            guildId: string;
            channelId: string;
            boundAt: number;
          }>) || [];

        if (!subscriptions.some((s) => s.channelId === channel.id)) {
          subscriptions.push({
            guildId: interaction.guildId,
            channelId: channel.id,
            boundAt: Date.now(),
          });
          await client.db.set("news_subscriptions", subscriptions);
        }

        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `✅ **設定已更新**\n已綁定當前頻道 <#${channel.id}> 接收通知。`,
          ),
        );

        await interaction.editReply({
          content: "",
          components: [container],
          flags: (1 << 15) | MessageFlags.Ephemeral,
        });
      } else {
        // Generic routing: forward to the relevant command via customId prefix (e.g. "gacha:log_page:...")
        const commandName = interaction.customId.split(":")[0];
        const command = client.commands.get(commandName);
        if (command) {
          try {
            await command.execute(client, interaction as any, tr, client.db);
          } catch (error: any) {
            if (error.code === 10062 || error.code === 40060) return;
            logger.error(`Error handling button interaction: ${error.message}`);
          }
        }
      }
    } else if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command && command.autocomplete) {
        try {
          await command.autocomplete(client, interaction, client.db);
        } catch (error) {
          console.error("Error handling autocomplete interaction:", error);
        }
      }
    }
  },
};

export default event;
