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
  ComponentType,
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

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("login")
    .setDescription("Login using Email and Password")
    .setNameLocalizations({ "zh-TW": "登入" })
    .setDescriptionLocalizations({ "zh-TW": "使用信箱和密碼登入" }),

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    const userId = interaction.user.id;

    if (interaction.isChatInputCommand()) {
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
    }

    if (interaction.isModalSubmit()) {
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
      }
    }
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
