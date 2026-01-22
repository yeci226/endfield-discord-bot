import path from "path";
import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} from "discord.js";
import { CustomDatabase } from "../../utils/Database";
import { verifyToken, getUserInfo } from "../../utils/skportApi";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("set-cookie")
    .setDescription("Set your Endfield account cookie")
    .setNameLocalizations({
      "zh-TW": "設定cookie",
    })
    .setDescriptionLocalizations({
      "zh-TW": "設定您的終末地帳號 Cookie",
    })
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Choose an action")
        .setNameLocalizations({
          "zh-TW": "動作",
        })
        .setDescriptionLocalizations({
          "zh-TW": "選擇動作",
        })
        .setRequired(true)
        .addChoices(
          {
            name: "Setup Cookie",
            value: "setup",
            name_localizations: { "zh-TW": "設定 Cookie" },
          },
          {
            name: "List Accounts",
            value: "list",
            name_localizations: { "zh-TW": "檢視已綁定帳號" },
          },
          {
            name: "Help",
            value: "help",
            name_localizations: { "zh-TW": "如何設定 Cookie" },
          },
        ),
    ),

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    const userId = interaction.user.id;

    // Helper to get/migrate accounts
    const getAccounts = async (): Promise<any[]> => {
      let accounts = (await db.get(`${userId}.accounts`)) as any[];
      if (!accounts) {
        // Migration check
        const oldCookie = await db.get(`${userId}.cookie`);
        const oldInfo = await db.get(`${userId}.info`);
        if (oldCookie && oldInfo) {
          accounts = [{ cookie: oldCookie, info: oldInfo }];
          await db.set(`${userId}.accounts`, accounts);
        } else {
          accounts = [];
        }
      }
      return accounts;
    };

    const extractAccountToken = (input: string): string => {
      // 1. If it's a full cookie string, find ACCOUNT_TOKEN
      const tokenMatch = input.match(/ACCOUNT_TOKEN=([^;\s]+)/);
      if (tokenMatch) return tokenMatch[1];

      // 2. If it's just the value or something else, handle it
      // If it contains other keys but not ACCOUNT_TOKEN, it might be the value itself if it's long
      if (!input.includes("=") && input.length > 20) return input;

      // Fallback
      return input;
    };

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "set-cookie:modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let cookie = interaction.fields
          .getTextInputValue("cookie-input")
          .trim();

        if (!cookie.includes("=") && cookie.length > 20) {
          cookie = `ACCOUNT_TOKEN=${cookie}`;
        } else {
          // Robust parsing for full cookie strings
          const token = extractAccountToken(cookie);
          cookie = `ACCOUNT_TOKEN=${token}`;
        }

        interface verifyTokenResponse {
          status: number;
          msg?: string;
          cred?: string;
          data?: {
            nickName: string;
            hgId: string;
          };
        }

        const result = (await verifyToken(
          cookie,
          interaction.locale,
        )) as verifyTokenResponse;

        if (result && result.status === 0 && result.cred) {
          const cred = result.cred;

          // Fetch Skport User Info
          const userResponse = await getUserInfo(cred, interaction.locale);

          let nickName = "Unknown";
          let hgId = "";
          let avatar = "";

          if (
            userResponse &&
            userResponse.code === 0 &&
            userResponse.data?.user?.basicUser
          ) {
            const basicUser = userResponse.data.user.basicUser;
            nickName = basicUser.nickname || "Unknown";
            hgId = basicUser.id;
            if (basicUser.avatar) {
              avatar = basicUser.avatar;
            }
          }

          const accounts = await getAccounts();

          // Check duplicate
          const exists = accounts.find(
            (acc) => acc.info.id === hgId || acc.info.nickname === nickName,
          );

          const accountData = {
            cred: cred,
            info: {
              id: hgId,
              nickname: nickName,
              avatar: avatar,
            },
          };

          if (exists) {
            // Update existing
            Object.assign(exists, accountData);
          } else {
            if (accounts.length >= 5) {
              const limitContainer =
                new ContainerBuilder().addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(
                    "❌ **管理員，您可綁定的帳號數量已達上限 (5)**",
                  ),
                );
              await interaction.editReply({
                content: "",
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: [limitContainer],
              });
              return;
            }
            accounts.push(accountData);
          }

          await db.set(`${userId}.accounts`, accounts);

          // Construct Container
          const container = new ContainerBuilder();

          const textDisplay = new TextDisplayBuilder().setContent(
            `✅ **驗證成功**\n歡迎管理員，**${nickName}**!\n已將此帳號加入綁定列表，並自動同步憑證。`,
          );

          container.addTextDisplayComponents(textDisplay);

          await interaction.editReply({
            content: "",
            flags: (1 << 15) | MessageFlags.Ephemeral,
            components: [container],
          });
        } else {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `❌ **驗證失敗**\nCookie 無效或已過期。${
                result && result.msg ? `\nErrors: ${result.msg}` : ""
              }`,
            ),
          );

          await interaction.editReply({
            content: "",
            flags: (1 << 15) | MessageFlags.Ephemeral,
            components: [container],
          });
        }
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      const action = interaction.options.getString("action");

      if (action === "setup") {
        const accounts = await getAccounts();
        if (accounts.length >= 5) {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "❌ **綁定失敗**\n管理員，您已綁定 5 個帳號，無法再新增。",
            ),
          );
          await interaction.reply({
            content: "",
            flags: (1 << 15) | MessageFlags.Ephemeral,
            components: [container],
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId("set-cookie:modal")
          .setTitle("設定 Endfield Cookie");

        const cookieInput = new TextInputBuilder()
          .setCustomId("cookie-input")
          .setLabel("輸入您的 Cookie")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("ACCOUNT_TOKEN=...")
          .setRequired(true);

        const firstActionRow =
          new ActionRowBuilder<TextInputBuilder>().addComponents(cookieInput);
        modal.addComponents(firstActionRow);

        await interaction.showModal(modal);
      } else if (action === "list") {
        const accounts = await getAccounts();
        const container = new ContainerBuilder();

        if (accounts.length === 0) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent("目前沒有綁定任何帳號。"),
          );
        } else {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**已綁定帳號 (${accounts.length}/5)**`,
            ),
          );

          for (const acc of accounts) {
            const user = acc.info;
            const textDisplay = new TextDisplayBuilder().setContent(
              `管理員，**${user.nickname}**`,
            );

            if (user.avatar) {
              const headerSection = new SectionBuilder()
                .addTextDisplayComponents(textDisplay)
                .setThumbnailAccessory(
                  new ThumbnailBuilder({ media: { url: user.avatar } }),
                );
              container.addSectionComponents(headerSection);
            } else {
              container.addTextDisplayComponents(textDisplay);
            }
          }
        }

        await interaction.reply({
          content: "",
          flags: (1 << 15) | MessageFlags.Ephemeral,
          components: [container],
        });
      } else if (action === "help") {
        const imagePath = path.join(__dirname, "../../assets/image.png");

        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "❓ **如何獲取 Cookie**\n1. 前往 [Skport](https://www.skport.com/) 並登入\n2. 按下 `F12` -> `Application` -> `Cookies` -> `https://www.skport.com`\n3. 找到 `ACCOUNT_TOKEN` 欄位 (例如: `%2FbSkkfDymDO7ci...`)\n4. 複製該值並填入",
          ),
        );

        const mediaGallery = new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder({
            media: { url: "attachment://image.png" },
          }),
        );
        container.addMediaGalleryComponents(mediaGallery);

        await interaction.reply({
          content: "",
          flags: (1 << 15) | MessageFlags.Ephemeral,
          components: [container],
          files: [{ attachment: imagePath, name: "image.png" }],
        });
      }
    }
  },
};

export default command;
