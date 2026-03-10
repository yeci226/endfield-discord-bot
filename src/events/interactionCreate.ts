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
import {
  getCommandAckPlan,
  ensureDeferredReply,
  replyOrFollowUp,
  TtlCache,
  fireAndForget,
} from "../utils/sharedCompat";

const webhook = process.env.CMDWEBHOOK
  ? new WebhookClient({ url: process.env.CMDWEBHOOK })
  : null;
const logger = new Logger("Interaction");
const localeCache = new TtlCache<string, string>(120000, 10000);

const event: Event = {
  name: Events.InteractionCreate,
  execute: async (client, interaction) => {
    const cachedLocale = await localeCache.getOrSetAsync(
      interaction.user.id,
      async () => (await client.db.get(`${interaction.user.id}.locale`)) || "",
    );
    const userLang = cachedLocale || toI18nLang(interaction.locale);
    localeCache.set(interaction.user.id, userLang);
    const tr = createTranslator(userLang);

    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      try {
        const commandName = command.data.name;
        const userId = interaction.user.id;
        const startTime = Date.now();

        // ========================================
        // 1. 速率限制檢查
        // ========================================
        const optimizations = (client as any).optimizations;
        if (optimizations?.rateLimiter) {
          const rateLimitCheck = optimizations.rateLimiter.check(userId);
          if (!rateLimitCheck.allowed) {
            const retryAfter = rateLimitCheck.retryAfter || 1;
            return replyOrFollowUp(interaction, {
              content: `⏱️ You're doing that too fast! Please retry after ${retryAfter}s.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }

        // ========================================
        // 2. 安全確認已 Defer
        // ========================================
        const ackPlan = getCommandAckPlan(command, { defaultEphemeral: true });
        if (ackPlan.shouldDefer) {
          await ensureDeferredReply(interaction, ackPlan.ephemeral);
        }

        // ========================================
        // 3. 帶超時的命令執行（有重試機制）
        // ========================================
        if (optimizations?.commandExecutor) {
          await optimizations.commandExecutor.execute(
            commandName,
            async () => {
              return command.execute(client, interaction, tr, client.db);
            },
            {
              timeoutMs: 30_000,
              maxRetries: 1,
            }
          );
        } else {
          await command.execute(client, interaction, tr, client.db);
        }

        // ========================================
        // 4. 記錄執行和統計
        // ========================================
        const executionMs = Date.now() - startTime;
        const sub = (
          interaction as ChatInputCommandInteraction
        ).options.getSubcommand(false);
        const group = (
          interaction as ChatInputCommandInteraction
        ).options.getSubcommandGroup(false);
        const cmdStr = `${commandName}${group ? ` ${group}` : ""}${sub ? ` ${sub}` : ""}`;
        logger.info(
          `Command ${cmdStr} executed by ${interaction.user.tag} (${userId}) in ${interaction.guild?.name ?? "DM"} (${interaction.guildId ?? "DM"}) - took ${executionMs}ms`,
        );

        // 追蹤命令使用統計
        if (optimizations?.commandUsageTracker) {
          optimizations.commandUsageTracker.track(commandName, executionMs);
        }

        // ========================================
        // 5. 發送 Webhook 日誌
        // ========================================
        if (webhook) {
          fireAndForget(
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
                    `\`\`\`${interaction.guild?.name ?? "Direct Message"} - ${interaction.guild?.id ?? interaction.user.id}\`\`\``,
                  )
                  .addFields({
                    name: commandName,
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
            }),
            logger,
          );
        }
      } catch (error: any) {
        // ========================================
        // 強化的錯誤處理
        // ========================================
        if (error.code === 10062 || error.code === 40060) {
          // Interaction expired or already handled, ignore
          return;
        }

        const optimizations = (client as any).optimizations;
        const commandName = (client.commands as any).get(interaction.commandName)?.data?.name || "unknown";

        logger.error(
          `Command execution error: ${error.message}${error.stack ? `\n${error.stack}` : ""}`,
        );

        // 追蹤錯誤統計
        if (optimizations?.commandUsageTracker) {
          optimizations.commandUsageTracker.trackError(commandName);
        }

        // 通過 EnhancedErrorHandler 處理
        if (optimizations?.errorHandler) {
          await optimizations.errorHandler.handle(error, {
            source: "CommandExecution",
            commandName,
            userId: interaction.user.id,
            guildId: interaction.guildId,
          });
        }

        // 回覆用戶
        if (interaction.replied || interaction.deferred) {
          try {
            // If it was a public defer, delete it to hide the "Loading..." from others
            if (!(interaction as any).ephemeral) {
              await interaction.deleteReply().catch(() => {});
            }
          } catch {}
          await interaction
            .followUp({
              content: tr("Error"),
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        } else {
          await replyOrFollowUp(interaction, {
            content: tr("Error"),
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
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
            await interaction
              .followUp({
                content: tr("Error"),
                flags: MessageFlags.Ephemeral,
              })
              .catch(() => {});
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
              invalidChannels.push(
                `<#${channelId}> (${tr("news_PermissionUnknown")})`,
              );
              continue;
            }

            const hasView = permissions.has(PermissionFlagsBits.ViewChannel);
            const hasSend = permissions.has(PermissionFlagsBits.SendMessages);

            if (hasView && hasSend) {
              validChannels.push(channelId);
            } else {
              const missing: string[] = [];
              if (!hasView) missing.push(tr("news_ViewChannel"));
              if (!hasSend) missing.push(tr("news_SendMessages"));
              invalidChannels.push(
                `<#${channelId}> (${tr("news_PermissionMissing")}${missing.join(", ")})`,
              );
            }
          } catch (e) {
            console.error(
              `Error checking permissions for channel ${channelId}:`,
              e,
            );
            invalidChannels.push(
              `<#${channelId}> (${tr("news_PermissionError")})`,
            );
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
              `${tr("news_SetupSuccess")}\n${tr("news_BindSuccessDetail")}\n${validChannels.map((id) => `<#${id}>`).join("\n")}`,
            ),
          );
        } else if (selectedChannels.length > 0 && validChannels.length === 0) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `${tr("news_BindFail")}\n${tr("news_BindFailDetail")}`,
            ),
          );
        } else {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(tr("news_UnbindAll")),
          );
        }

        if (invalidChannels.length > 0) {
          container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(1),
          );
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `${tr("news_InvalidChannels")}\n${invalidChannels.join("\n")}\n${tr("news_PermissionTip")}`,
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
              `${tr("news_BindFail")}\n${tr("news_PermissionTip")}`,
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
            tr("news_BindCurrentSuccess", { channelId: channel.id }),
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
