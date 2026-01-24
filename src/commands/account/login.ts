import path from "path";
import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  ButtonBuilder,
  ButtonStyle,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  AutocompleteInteraction,
} from "discord.js";
import { CustomDatabase } from "../../utils/Database";
import {
  loginByEmailPassword,
  verifyToken,
  getUserInfo,
} from "../../utils/skportApi";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { VerificationServer } from "../../utils/VerificationServer";

// Helper to get/migrate accounts
const getAccounts = async (
  db: CustomDatabase,
  userId: string,
): Promise<any[]> => {
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

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("login")
    .setDescription("Login using Email/Password or Cookie")
    .setNameLocalizations({ "zh-TW": "登入" })
    .setDescriptionLocalizations({ "zh-TW": "登入或管理終末地帳號" })
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Choose login method or action")
        .setNameLocalizations({ "zh-TW": "動作" })
        .setDescriptionLocalizations({ "zh-TW": "選擇登入方式或管理動作" })
        .setRequired(false)
        .addChoices(
          {
            name: "Email & Password",
            value: "email",
            name_localizations: { "zh-TW": "帳號密碼登入" },
          },
          {
            name: "Input Cookie",
            value: "cookie",
            name_localizations: { "zh-TW": "輸入 Cookie 登入" },
          },
          {
            name: "List Accounts",
            value: "list",
            name_localizations: { "zh-TW": "檢視已綁定帳號" },
          },
          {
            name: "Unbind Account",
            value: "unbind",
            name_localizations: { "zh-TW": "解除帳號綁定" },
          },
          {
            name: "Help",
            value: "help",
            name_localizations: { "zh-TW": "如何獲取 Cookie" },
          },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("account")
        .setDescription("Select an account to unbind")
        .setNameLocalizations({ "zh-TW": "帳號" })
        .setDescriptionLocalizations({ "zh-TW": "選擇要解除綁定的帳號" })
        .setAutocomplete(true),
    ),

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    const userId = interaction.user.id;

    if (interaction.isChatInputCommand()) {
      const action = interaction.options.getString("action") || "email";

      if (action === "email") {
        const modal = new ModalBuilder()
          .setCustomId("login:credentials")
          .setTitle("Endfield 帳號登入");

        const emailInput = new TextInputBuilder()
          .setCustomId("email")
          .setLabel("電子信箱")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("example@gmail.com")
          .setRequired(true);

        const passwordInput = new TextInputBuilder()
          .setCustomId("password")
          .setLabel("密碼")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("請輸入您的密碼")
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(emailInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(passwordInput),
        );

        await interaction.showModal(modal);
        return;
      } else if (action === "cookie") {
        const accounts = await getAccounts(db, userId);
        if (accounts.length >= 5) {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "❌ **綁定失敗**\n管理員，您已綁定 5 個帳號，無法再新增。",
            ),
          );
          await interaction.reply({
            content: "",
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId("login:cookie")
          .setTitle("設定 Endfield Cookie");

        const cookieInput = new TextInputBuilder()
          .setCustomId("cookie-input")
          .setLabel("輸入您的 Cookie")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("ACCOUNT_TOKEN=...")
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(cookieInput),
        );

        await interaction.showModal(modal);
        return;
      } else if (action === "list") {
        const accounts = await getAccounts(db, userId);
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
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [container],
        });
        return;
      } else if (action === "help") {
        const imagePath = path.join(__dirname, "../../assets/image.png");
        const image2Path = path.join(__dirname, "../../assets/image2.png");

        const container = new ContainerBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "❓ **如何獲取 Cookie**\n" +
                "**方法一：Application 分頁**\n" +
                "1. 前往 [Skport](https://www.skport.com/) 並登入\n" +
                "2. 按下 `F12` -> `Application` -> `Cookies` -> `https://www.skport.com`\n" +
                "3. 找到 `ACCOUNT_TOKEN` 欄位並複製其數值",
            ),
          )
          .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
              new MediaGalleryItemBuilder({
                media: { url: "attachment://image1.png" },
              }),
            ),
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "\n**方法二：Network 分頁 (推薦)**\n" +
                "1. 前往 [Skport](https://www.skport.com/) 並登入\n" +
                "2. 按下 `F12` -> `Network` (網路)\n" +
                "3. 在搜尋框輸入 `account_token` 並重新整理網頁\n" +
                "4. 點擊任意一個請求，在右側的 `Request Headers` 中找到 `cookie` 欄位\n" +
                "5. 複製整串 Cookie 內容並填入即可",
            ),
          )
          .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
              new MediaGalleryItemBuilder({
                media: { url: "attachment://image2.png" },
              }),
            ),
          );

        await interaction.reply({
          content: "",
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [container],
          files: [
            { attachment: imagePath, name: "image1.png" },
            { attachment: image2Path, name: "image2.png" },
          ],
        });
        return;
      } else if (action === "unbind") {
        const accountIndexStr = interaction.options.getString("account");
        if (!accountIndexStr) {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "❌ **解除綁定失敗**\n請選擇一個帳號。",
            ),
          );
          await interaction.reply({
            content: "",
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
          });
          return;
        }

        const accounts = await getAccounts(db, userId);
        const index = parseInt(accountIndexStr);
        if (isNaN(index) || !accounts[index]) {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "❌ **解除綁定失敗**\n無效的帳號索引。",
            ),
          );
          await interaction.reply({
            content: "",
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
          });
          return;
        }

        const removed = accounts.splice(index, 1)[0];
        await db.set(`${userId}.accounts`, accounts);

        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `✅ **解除綁定成功**\n管理員，已成功解除綁定帳號：**${removed.info.nickname}** (${removed.info.id})。`,
          ),
        );

        await interaction.reply({
          content: "",
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [container],
        });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      // Login Credentials Handler
      if (interaction.customId === "login:credentials") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const email = interaction.fields.getTextInputValue("email");
        const password = interaction.fields.getTextInputValue("password");

        const result = await loginByEmailPassword({ email, password });

        if (!result) {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "❌ **登入請求失敗，請稍後再試。**",
            ),
          );
          await interaction.editReply({
            content: "",
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
          });
          return;
        }

        if (result.message === "exceeded maximum number") {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "❌ **登入次數過多，請稍候再試。**",
            ),
          );
          await interaction.editReply({
            content: "",
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
          });
          return;
        }

        if (
          result.msg === "Human-machine verification required." &&
          result.data?.captcha
        ) {
          const { geetestId, riskType, challenge } = result.data.captcha;
          const sessionId = Math.random().toString(36).substring(2, 12);
          const baseUrl =
            process.env.VERIFY_PUBLIC_URL || "http://localhost:3838";
          const verifyUrl = `${baseUrl}/verify?captchaId=${geetestId}&riskType=${encodeURIComponent(riskType)}&challenge=${challenge}&session=${sessionId}`;

          VerificationServer.onResult(sessionId, async (captchaResult: any) => {
            const loginRes = await loginByEmailPassword(
              { email, password },
              captchaResult,
            );
            if (loginRes && loginRes.status === 0 && loginRes.data?.token) {
              await handleLoginSuccess(
                interaction,
                loginRes.data.token,
                db,
                true,
              );
            } else {
              const errContainer =
                new ContainerBuilder().addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(
                    `❌ **驗證後自動登入失敗**\n${loginRes?.msg || "代碼已過期"}`,
                  ),
                );
              await interaction.followUp({
                content: "",
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: [errContainer],
              });
            }
          });

          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "🛡️ **由 Gryphline 觸發的人機驗證**\n" +
                "請點擊下方網址並在瀏覽器中開啟：\n" +
                `**[👉 點我進行驗證](${verifyUrl})**\n\n` +
                "1. 開啟上述網址後，驗證碼會自動載入。\n" +
                "2. 完成驗證後，網頁會自動傳回結果。\n" +
                "3. **機器人偵測到驗證成功後會自動完成登入。**",
            ),
          );

          const verifyBtn = new ButtonBuilder()
            .setCustomId(`login:verify:${email}:${password}:${sessionId}`)
            .setLabel("手動檢查驗證狀態")
            .setStyle(ButtonStyle.Secondary);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            verifyBtn,
          );

          await interaction.editReply({
            content: "",
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container, row as any],
          });
          return;
        }

        if (result.status === 0 && result.data?.token) {
          return handleLoginSuccess(interaction, result.data.token, db);
        }

        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `❌ **登入失敗**\n${result.msg || "未知錯誤"}`,
          ),
        );
        await interaction.editReply({
          content: "",
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [container],
        });
      } else if (interaction.customId.startsWith("login:captcha:")) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const [, , email, password] = interaction.customId.split(":");
        const resultRaw =
          interaction.fields.getTextInputValue("captcha_result");

        try {
          const captchaData = JSON.parse(resultRaw);
          const loginRes = await loginByEmailPassword(
            { email, password },
            captchaData,
          );

          if (loginRes && loginRes.status === 0 && loginRes.data?.token) {
            return handleLoginSuccess(interaction, loginRes.data.token, db);
          } else {
            const container = new ContainerBuilder().addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `❌ **驗證後登入失敗**\n${loginRes?.msg || "驗證無效或已過期"}`,
              ),
            );
            await interaction.editReply({
              content: "",
              flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
              components: [container],
            });
          }
        } catch (e) {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "❌ **無效的 JSON 格式**\n請確保您完整複製了驗證工具提供的結果。",
            ),
          );
          await interaction.editReply({
            content: "",
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
          });
        }
      } else if (interaction.customId === "login:cookie") {
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

          const accounts = await getAccounts(db, userId);

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
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
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
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
          });
        }
      }
    }
  },

  autocomplete: async (
    client: ExtendedClient,
    interaction: AutocompleteInteraction,
    db: CustomDatabase,
  ) => {
    const userId = interaction.user.id;
    let accounts = (await db.get(`${userId}.accounts`)) as any[];

    // Migration / Fallback same as execute
    if (!accounts) {
      const oldCookie = await db.get(`${userId}.cookie`);
      const oldInfo = await db.get(`${userId}.info`);
      if (oldCookie && oldInfo) {
        accounts = [{ cookie: oldCookie, info: oldInfo }];
      } else {
        accounts = [];
      }
    }

    if (!accounts || accounts.length === 0) {
      // Autocomplete expects respond to always be called, even with empty
      await interaction.respond([]);
      return;
    }

    const focusedValue = interaction.options.getFocused();
    const filtered = accounts
      .map((acc, index) => ({
        name: `${acc.info.nickname} (${acc.info.id})`,
        value: index.toString(),
      }))
      .filter((choice) => choice.name.includes(focusedValue));

    await interaction.respond(filtered.slice(0, 25));
  },
};

// Handle Button and subsequent result check
export const handleLoginButton = async (
  interaction: any,
  client: ExtendedClient,
  db: CustomDatabase,
) => {
  if (interaction.customId.startsWith("login:verify:")) {
    const [, , email, password, sessionId] = interaction.customId.split(":");

    // Check if server already has the result
    const serverResult = VerificationServer.getResult(sessionId);

    if (serverResult) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const loginRes = await loginByEmailPassword(
        { email, password },
        serverResult,
      );
      if (loginRes && loginRes.status === 0 && loginRes.data?.token) {
        return handleLoginSuccess(interaction, loginRes.data.token, db);
      } else {
        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `❌ **驗證後登入失敗**\n${loginRes?.msg || "代碼已過期"}`,
          ),
        );
        await interaction.editReply({
          content: "",
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [container],
        });
      }
      return;
    }

    // Fallback to Modal if not found automatically
    const modal = new ModalBuilder()
      .setCustomId(`login:captcha:${email}:${password}`)
      .setTitle("填寫驗證結果 (自動偵測失敗)");

    const resultInput = new TextInputBuilder()
      .setCustomId("captcha_result")
      .setLabel("驗證 JSON 代碼 (請貼上網頁提供的 JSON)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('{"captcha_id": "...", "lot_number": "...", ...}')
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(resultInput),
    );
    await interaction.showModal(modal);
  }
};

async function handleLoginSuccess(
  interaction: any,
  token: string,
  db: CustomDatabase,
  isFollowUp: boolean = false,
) {
  const userId = interaction.user.id;
  const cookie = `ACCOUNT_TOKEN=${token}`;

  const result = await verifyToken(cookie, interaction.locale);

  if (result && (result as any).status === 0 && (result as any).cred) {
    const cred = (result as any).cred;
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
      avatar = basicUser.avatar || "";
    }

    let accounts = (await db.get(`${userId}.accounts`)) || [];
    const exists = accounts.find((acc: any) => acc.info.id === hgId);

    const accountData = {
      cred: cred,
      info: { id: hgId, nickname: nickName, avatar: avatar },
    };

    if (exists) {
      Object.assign(exists, accountData);
    } else {
      if (accounts.length >= 5) {
        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent("❌ **已達帳號綁定上限 (5)**"),
        );
        const replyObj = {
          content: "",
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          components: [container],
        };
        if (isFollowUp) await interaction.followUp(replyObj);
        else await interaction.editReply(replyObj);
        return;
      }
      accounts.push(accountData);
    }

    await db.set(`${userId}.accounts`, accounts);

    const container = new ContainerBuilder();
    const textDisplay = new TextDisplayBuilder().setContent(
      `✅ **登入並綁定成功**\n歡迎回來，**${nickName}**!`,
    );

    if (avatar) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(textDisplay)
          .setThumbnailAccessory(
            new ThumbnailBuilder({ media: { url: avatar } }),
          ),
      );
    } else {
      container.addTextDisplayComponents(textDisplay);
    }

    const finalReply = {
      content: "",
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [container],
    };
    if (isFollowUp) await interaction.followUp(finalReply);
    else await interaction.editReply(finalReply);
  } else {
    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "❌ **獲取登入憑證失敗**\n請重新嘗試登入。",
      ),
    );
    const failReply = {
      content: "",
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [container],
    };
    if (isFollowUp) await interaction.followUp(failReply);
    else await interaction.editReply(failReply);
  }
}

export default command;
