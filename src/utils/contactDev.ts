import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

const IMAGE_UPLOAD_ID = "attachments";
const MAX_IMAGE_ATTACHMENTS = 4;

const PREFIX = "contact-dev";
const DEFAULT_DEVELOPER_IDS = ["283946584461410305", "878830839822176287"];
const cooldowns = new Map<string, number>();
const categoryLabels: Record<string, string> = {
  bug: "錯誤回報",
  suggestion: "功能建議",
  question: "問題詢問",
  other: "其他",
};

function developerIds(): string[] {
  const configured = [process.env.CONTACT_DEV_IDS, process.env.DEVIDS, process.env.DEVELOPER_ID]
    .filter(Boolean)
    .join(",");
  const ids = configured.split(/[\s,]+/).map((id) => id.trim()).filter((id) => /^\d{15,25}$/.test(id));
  return [...new Set(ids.length ? ids : DEFAULT_DEVELOPER_IDS)];
}

function isDeveloper(id: string): boolean {
  return developerIds().includes(id);
}

function buttons(userId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:reply:${userId}`).setLabel("回覆使用者").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:close:${userId}`).setLabel("關閉").setStyle(ButtonStyle.Secondary),
  );
}

function continueButton(userId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:continue:${userId}`).setLabel("繼續回覆").setStyle(ButtonStyle.Primary),
  );
}

function imageUpload() {
  return new FileUploadBuilder({
    custom_id: IMAGE_UPLOAD_ID,
    min_values: 0,
    max_values: MAX_IMAGE_ATTACHMENTS,
    required: false,
    file_types: ["image"],
  } as any);
}

function uploadedImages(interaction: any): any[] {
  const attachments = interaction.fields.getUploadedFiles(IMAGE_UPLOAD_ID, false);
  return attachments ? [...attachments.values()] : [];
}

function isImageAttachment(attachment: any): boolean {
  const contentType = String(attachment.contentType || "").toLowerCase();
  const filename = String(attachment.name || "").toLowerCase();
  return contentType.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(filename);
}

async function downloadImages(interaction: any) {
  const attachments = uploadedImages(interaction);
  if (attachments.some((attachment) => !isImageAttachment(attachment))) {
    throw new Error("Only image attachments are supported");
  }
  return Promise.all(
    attachments.map(async (attachment, index) => {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`Failed to download attachment ${attachment.id}`);
      const fallbackName = `image-${index + 1}.png`;
      const name = String(attachment.name || fallbackName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallbackName;
      return { attachment: Buffer.from(await response.arrayBuffer()), name };
    }),
  );
}

async function replyEphemeral(interaction: any, content: string) {
  if (interaction.deferred || interaction.replied) return interaction.editReply({ content });
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function contactModal() {
  const category = new StringSelectMenuBuilder()
    .setCustomId("category")
    .setPlaceholder("選擇問題類型")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      { label: "錯誤回報", value: "bug", description: "功能異常、簽到失敗或錯誤訊息" },
      { label: "功能建議", value: "suggestion", description: "想新增或改善的功能" },
      { label: "問題詢問", value: "question", description: "需要開發者協助確認的問題" },
      { label: "其他", value: "other", description: "不屬於以上分類的內容" },
    );
  const message = new TextInputBuilder()
    .setCustomId("message")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(1)
    .setMaxLength(1800)
    .setRequired(true)
    .setPlaceholder("請描述問題、建議或想詢問的內容");
  return new ModalBuilder()
    .setCustomId(`${PREFIX}:form`)
    .setTitle("聯絡機器人開發者")
    .setLabelComponents(
      new LabelBuilder().setLabel("問題類型").setDescription("選擇最接近的分類").setStringSelectMenuComponent(category),
      new LabelBuilder().setLabel("訊息").setDescription("最多 1800 字").setTextInputComponent(message),
      new LabelBuilder().setLabel("圖片附件").setDescription("可附加最多 4 張圖片").setFileUploadComponent(imageUpload()),
    );
}

export async function showContactDevModal(interaction: any): Promise<void> {
  await interaction.showModal(contactModal());
}

export async function sendContactDevMessage(interaction: any): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  const message = interaction.fields.getTextInputValue("message").trim();
  const category = interaction.fields.getStringSelectValues("category")[0] || "other";
  if (!message) {
    await replyEphemeral(interaction, "請輸入要傳給開發者的訊息。");
    return;
  }
  let files;
  try {
    files = await downloadImages(interaction);
  } catch {
    await replyEphemeral(interaction, "只能附加圖片檔案，且圖片目前無法讀取。");
    return;
  }
  const key = `${interaction.user.id}:${interaction.client.user?.id || "endfield"}`;
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < 30_000) {
    await replyEphemeral(interaction, `請再等 ${Math.ceil((30_000 - (now - last)) / 1000)} 秒後再送出下一則訊息。`);
    return;
  }
  cooldowns.set(key, now);

  const developers = [];
  for (const id of developerIds()) {
    try {
      developers.push(await interaction.client.users.fetch(id));
    } catch (error) {
      console.error(`Failed to fetch developer ${id}:`, error);
    }
  }
  if (!developers.length) {
    await replyEphemeral(interaction, "目前找不到開發者，請稍後再試。");
    return;
  }
  const source = interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})\n<#${interaction.channelId}>` : "私訊";
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("新的開發者聯絡訊息")
    .setDescription(message)
    .addFields(
      { name: "使用者", value: `${interaction.user.tag} (${interaction.user.id})` },
      { name: "分類", value: categoryLabels[category] || category, inline: true },
      { name: "來源", value: source, inline: true },
    )
    .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
    .setTimestamp()
    .setFooter({ text: `來源機器人：${interaction.client.user?.username || "Endfield"}` });
  let delivered = 0;
  for (const developer of developers) {
    try {
      await developer.send({ embeds: [embed], components: [buttons(interaction.user.id)], files: files.map((file) => ({ ...file })), allowedMentions: { parse: [] } });
      delivered++;
    } catch (error) {
      console.error(`Failed to send contact message to ${developer.id}:`, error);
    }
  }
  await replyEphemeral(interaction, delivered ? "訊息已送給開發者。" : "訊息送出失敗，請稍後再試。");
}

export async function handleContactDevInteraction(interaction: any): Promise<boolean> {
  if (!interaction.customId?.startsWith(`${PREFIX}:`)) return false;
  if (interaction.isModalSubmit() && interaction.customId === `${PREFIX}:form`) {
    await sendContactDevMessage(interaction);
    return true;
  }
  const [, action, userId] = interaction.customId.split(":");
  if (!userId || !/^\d{15,25}$/.test(userId)) return true;

  if (action === "continue" && interaction.isButton()) {
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "這個回覆按鈕不是給你的。", flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }
    await showContactDevModal(interaction);
    return true;
  }

  if (!isDeveloper(interaction.user.id)) {
    await interaction.reply({ content: "只有開發者可以操作這個按鈕。", flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  if (action === "close" && interaction.isButton()) {
    await interaction.update({ components: [] }).catch(() => {});
    return true;
  }
  if (action === "reply" && interaction.isButton()) {
    const input = new TextInputBuilder().setCustomId("reply").setStyle(TextInputStyle.Paragraph).setMaxLength(1800).setRequired(true).setPlaceholder("輸入要回覆使用者的內容");
    const modal = new ModalBuilder()
      .setCustomId(`${PREFIX}:modal:${userId}`)
      .setTitle("回覆使用者")
      .setLabelComponents(
        new LabelBuilder().setLabel("回覆內容").setTextInputComponent(input),
        new LabelBuilder().setLabel("圖片附件").setDescription("可附加最多 4 張圖片").setFileUploadComponent(imageUpload()),
      );
    await interaction.showModal(modal).catch(() => {});
    return true;
  }
  if (action === "modal" && interaction.isModalSubmit()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const reply = interaction.fields.getTextInputValue("reply").trim();
    let files;
    try {
      files = await downloadImages(interaction);
    } catch {
      await replyEphemeral(interaction, "只能附加圖片檔案，且圖片目前無法讀取。");
      return true;
    }
    try {
      const user = await interaction.client.users.fetch(userId);
      await user.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("開發者回覆").setDescription(reply).setTimestamp().setFooter({ text: `來源機器人：${interaction.client.user?.username || "Endfield"}` })], components: [continueButton(user.id)], files: files.map((file) => ({ ...file })), allowedMentions: { parse: [] } });
      await replyEphemeral(interaction, "已回覆使用者。");
    } catch (error) {
      console.error(`Failed to reply to user ${userId}:`, error);
      await replyEphemeral(interaction, "無法傳送回覆，使用者可能關閉了私人訊息。").catch(() => {});
    }
    return true;
  }
  return true;
}
