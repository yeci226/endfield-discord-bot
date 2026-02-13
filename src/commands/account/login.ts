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
  getGamePlayerBinding,
} from "../../utils/skportApi";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { VerificationClient } from "../../web/VerificationClient";
import { getAccounts, saveAccounts } from "../../utils/accountUtils";
import { decryptAccount } from "../../utils/cryptoUtils";

// Helper to get/migrate accounts
// getAccounts is now imported from accountUtils to ensure consistent encryption handling.

export const extractAccountToken = (input: string): string => {
  if (!input) return "";
  let target = input.trim();

  // 0. Handle JSON if the user pasted the whole account object or info
  if (target.startsWith("{")) {
    try {
      const parsed = JSON.parse(target);
      if (parsed.token) return String(parsed.token);
      if (parsed.ACCOUNT_TOKEN) return String(parsed.ACCOUNT_TOKEN);
      if (parsed.cookie) return extractAccountToken(String(parsed.cookie));
      // If it's just an info object without token, we can't do much, but let's see if there's anything else
    } catch (e) {}
  }

  // 1. If it's a full cookie string, find ACCOUNT_TOKEN
  const tokenMatch = target.match(/ACCOUNT_TOKEN=([^;\s]+)/);
  if (tokenMatch) return tokenMatch[1];

  // 2. If it contains other keys but not ACCOUNT_TOKEN, it might be the value itself if it's long
  if (!target.includes("=") && target.length > 20) return target;

  // Fallback (might be a raw token)
  return target;
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
        .setRequired(true)
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
          .setTitle(tr("login_Title"));

        const emailInput = new TextInputBuilder()
          .setCustomId("email")
          .setLabel(tr("login_EmailPlaceholder"))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(tr("login_EmailInput"))
          .setRequired(true);

        const passwordInput = new TextInputBuilder()
          .setCustomId("password")
          .setLabel(tr("login_PasswordPlaceholder"))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(tr("login_PasswordInput"))
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
            new TextDisplayBuilder().setContent(tr("login_Limit")),
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
          .setTitle(tr("login_CookieSetTitle"));

        const cookieInput = new TextInputBuilder()
          .setCustomId("cookie-input")
          .setLabel(tr("login_CookieSetTitle"))
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder(tr("login_CookiePlaceholder"))
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
            new TextDisplayBuilder().setContent(tr("login_ListEmpty")),
          );
        } else {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              tr("login_ListTitle").replace(
                "<current>",
                accounts.length.toString(),
              ),
            ),
          );

          for (const acc of accounts) {
            const user = acc.info;
            const textDisplay = new TextDisplayBuilder().setContent(
              tr("login_Welcome").replace("<name>", user.nickname),
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
              tr("login_HelpTitle") +
                "\n" +
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
            new TextDisplayBuilder().setContent(tr("login_UnbindFail")),
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
            new TextDisplayBuilder().setContent(tr("login_UnbindInvalid")),
          );
          await interaction.reply({
            content: "",
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
          });
          return;
        }

        const removed = accounts.splice(index, 1)[0];
        await saveAccounts(db, userId, accounts);

        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            tr("login_UnbindSuccess")
              .replace("<name>", removed.info.nickname)
              .replace("<id>", removed.info.id),
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
          (result.data?.captcha || result.aigisHeader)
        ) {
          let captchaData = result.data?.captcha;
          let aigisData: any = {};

          if (result.aigisHeader) {
            aigisData = JSON.parse(result.aigisHeader);
            if (typeof aigisData.data === "string") {
              captchaData = JSON.parse(aigisData.data);
            } else {
              captchaData = aigisData.data;
            }
          }

          const geetestId = captchaData?.gt || result.data?.captcha?.geetestId;
          const riskType =
            aigisData?.mmt_type || result.data?.captcha?.riskType;
          const challenge =
            captchaData?.challenge || result.data?.captcha?.challenge;
          const success = captchaData?.success;
          const new_captcha = captchaData?.new_captcha;
          const aigisSessionId = aigisData?.session_id;

          const sessionId = Math.random().toString(36).substring(2, 12);
          const baseUrl =
            process.env.VERIFY_PUBLIC_URL || "http://localhost:3000/endfield";

          const params = new URLSearchParams({
            captchaId: geetestId,
            challenge: challenge,
            session: sessionId,
          });
          if (riskType) params.append("riskType", riskType.toString());
          if (success !== undefined)
            params.append("success", success.toString());
          if (new_captcha !== undefined)
            params.append("new_captcha", new_captcha.toString());
          if (aigisSessionId) params.append("aigisSessionId", aigisSessionId);

          const verifyUrl = `${baseUrl}/verify?${params.toString()}`;

          VerificationClient.onResult(sessionId, async (captchaResult: any) => {
            try {
              const loginRes = await loginByEmailPassword(
                { email, password },
                captchaResult,
              );
              if (loginRes && loginRes.status === 0 && loginRes.data?.token) {
                await handleLoginSuccess(
                  interaction,
                  loginRes.data.token,
                  db,
                  tr,
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
            } catch (e: any) {
              console.error("[Login] Captcha auto-retry failed:", e);
            }
          });

          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "為了保護您的帳號安全，請點擊下方按鈕在瀏覽器中完成 Geetest 驗證。驗證完成後，機器人將會自動繼續登入流程。",
            ),
          );

          const verifyBtn = new ButtonBuilder()
            .setLabel("進行驗證 (Verify)")
            .setURL(verifyUrl)
            .setStyle(ButtonStyle.Link);

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
          return handleLoginSuccess(interaction, result.data.token, db, tr);
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
            return handleLoginSuccess(interaction, loginRes.data.token, db, tr);
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
          token?: string; // Add this for salt support
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
          const userResponse = await getUserInfo(
            cred,
            interaction.locale,
            result.token,
          );

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

          // Fetch Game Roles
          const bindings = await getGamePlayerBinding(
            cookie,
            interaction.locale,
            cred,
            result.token,
          );
          const endfield = bindings?.find((b) => b.appCode === "endfield");
          const roles = endfield ? endfield.bindingList : [];

          const accountData = {
            cookie: cookie,
            cred: cred,
            salt: result.token, // Store the dynamic salt (token)
            roles: roles, // Store roles to avoid redundant getGamePlayerBinding calls
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

          // accountData fields are plaintext here, saveAccounts will handle encryption
          await saveAccounts(db, userId, accounts);

          // Construct Container
          const container = new ContainerBuilder();

          const textDisplay = new TextDisplayBuilder().setContent(
            tr("login_CookieSuccess").replace("<name>", nickName),
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

          await interaction.editReply({
            content: "",
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
          });
        } else {
          const container = new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              tr("AuthError") +
                (result && result.msg ? `\nErrors: ${result.msg}` : ""),
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
    let accounts = await getAccounts(db, userId);

    if (!accounts || accounts.length === 0) {
      // Autocomplete expects respond to always be called, even with empty
      await interaction.respond([]);
      return;
    }

    const focusedValue = interaction.options.getFocused();
    const filtered = accounts
      .map((acc: any, index: number) => ({
        name: `${acc.info.nickname} (${acc.info.id})`,
        value: index.toString(),
      }))
      .filter((choice: any) => choice.name.includes(focusedValue));

    await interaction.respond(filtered.slice(0, 25));
  },
};

async function handleLoginSuccess(
  interaction: any,
  token: string,
  db: CustomDatabase,
  tr: any,
  isFollowUp: boolean = false,
) {
  const userId = interaction.user.id;
  const cookie = `ACCOUNT_TOKEN=${token}`;

  const result = await verifyToken(cookie, interaction.locale);

  if (result && (result as any).status === 0 && (result as any).cred) {
    const cred = (result as any).cred;
    const userResponse = await getUserInfo(
      cred,
      interaction.locale,
      (result as any).token,
    );

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

    let accounts = await getAccounts(db, userId);
    const exists = accounts.find((acc: any) => acc.info.id === hgId);

    // Fetch Game Roles
    const bindings = await getGamePlayerBinding(
      cookie,
      interaction.locale,
      cred,
      (result as any).token,
    );
    const endfield = bindings?.find((b) => b.appCode === "endfield");
    const roles = endfield ? endfield.bindingList : [];

    const accountData = {
      cookie: cookie,
      cred: cred,
      salt: (result as any).token,
      roles: roles,
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

    await saveAccounts(db, userId, accounts);

    const container = new ContainerBuilder();
    const textDisplay = new TextDisplayBuilder().setContent(
      tr("login_CookieSuccess").replace("<name>", nickName),
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
      new TextDisplayBuilder().setContent(tr("AuthError")),
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
