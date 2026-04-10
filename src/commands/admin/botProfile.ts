import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  ModalSubmitInteraction,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { CustomDatabase } from "../../utils/Database";

const MAX_IMAGE_BYTES = 9 * 1024 * 1024; // 9 MB

async function attachmentToDataUri(
  url: string,
  size: number,
  tr: any,
): Promise<string> {
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(
      tr("botProfile_ImageTooLarge", { size: (size / 1024 / 1024).toFixed(1) }),
    );
  }
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(tr("botProfile_ImageFetchFailed", { status: response.status }));
  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return `data:${contentType};base64,${base64}`;
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("bot-profile")
    .setDescription("Manage bot guild-specific profile (admin only)")
    .setNameLocalizations({ "zh-TW": "機器人設定" })
    .setDescriptionLocalizations({
      "zh-TW": "管理機器人在此伺服器的個人資料（僅管理員）",
    })
    .addSubcommand((sub) =>
      sub
        .setName("avatar")
        .setDescription("Set bot guild-specific avatar")
        .setNameLocalizations({ "zh-TW": "頭像" })
        .setDescriptionLocalizations({ "zh-TW": "設定機器人在此伺服器的頭像" })
        .addAttachmentOption((op) =>
          op
            .setName("image")
            .setDescription("Avatar image (PNG / JPG / GIF, max 9 MB)")
            .setNameLocalizations({ "zh-TW": "圖片" })
            .setDescriptionLocalizations({
              "zh-TW": "頭像圖片（PNG / JPG / GIF，最大 9 MB）",
            })
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("nickname")
        .setDescription("Set or reset bot nickname in this guild")
        .setNameLocalizations({ "zh-TW": "暱稱" })
        .setDescriptionLocalizations({
          "zh-TW": "設定或重置機器人在此伺服器的暱稱",
        })
        .addStringOption((op) =>
          op
            .setName("name")
            .setDescription("New nickname (leave empty to reset)")
            .setNameLocalizations({ "zh-TW": "名稱" })
            .setDescriptionLocalizations({ "zh-TW": "新暱稱（留空以重置）" })
            .setMaxLength(32)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("banner")
        .setDescription("Set bot guild-specific banner")
        .setNameLocalizations({ "zh-TW": "橫幅" })
        .setDescriptionLocalizations({
          "zh-TW": "設定機器人在此伺服器的橫幅（建議 600×240）",
        })
        .addAttachmentOption((op) =>
          op
            .setName("image")
            .setDescription(
              "Banner image (PNG / JPG / GIF, recommended 600×240, max 9 MB)",
            )
            .setNameLocalizations({ "zh-TW": "圖片" })
            .setDescriptionLocalizations({
              "zh-TW": "橫幅圖片（PNG / JPG / GIF，建議 600×240，最大 9 MB）",
            })
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("Reset bot profile fields to default")
        .setNameLocalizations({ "zh-TW": "重置" })
        .setDescriptionLocalizations({ "zh-TW": "重置機器人的個人資料至預設" })
        .addStringOption((op) =>
          op
            .setName("target")
            .setDescription("Which field to reset")
            .setNameLocalizations({ "zh-TW": "項目" })
            .setDescriptionLocalizations({ "zh-TW": "要重置的項目" })
            .addChoices(
              { name: "頭像", value: "avatar" },
              { name: "暱稱", value: "nickname" },
              { name: "橫幅", value: "banner" },
              { name: "全部", value: "all" },
            )
            .setRequired(true),
        ),
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild,
    ) as SlashCommandBuilder,

  execute: async (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any,
    _db: CustomDatabase,
  ) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.isChatInputCommand()) return;

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply(tr("botProfile_GuildOnly"));
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const body: Record<string, any> = {};
    let successMsg = "";

    try {
      if (subcommand === "avatar") {
        const attachment = interaction.options.getAttachment("image", true);
        body.avatar = await attachmentToDataUri(attachment.url, attachment.size, tr);
        successMsg = tr("botProfile_AvatarSuccess");
      } else if (subcommand === "nickname") {
        const name = interaction.options.getString("name") ?? null;
        body.nick = name ?? "";
        successMsg = name
          ? tr("botProfile_NicknameSet", { name })
          : tr("botProfile_NicknameReset");
      } else if (subcommand === "banner") {
        const attachment = interaction.options.getAttachment("image", true);
        body.banner = await attachmentToDataUri(attachment.url, attachment.size, tr);
        successMsg = tr("botProfile_BannerSuccess");
      } else if (subcommand === "reset") {
        const target = interaction.options.getString("target", true);
        if (target === "avatar" || target === "all") body.avatar = null;
        if (target === "nickname" || target === "all") body.nick = "";
        if (target === "banner" || target === "all") body.banner = null;
        const targetKeyMap: Record<string, string> = {
          avatar: "botProfile_Target_Avatar",
          nickname: "botProfile_Target_Nickname",
          banner: "botProfile_Target_Banner",
          all: "botProfile_Target_All",
        };
        successMsg = tr("botProfile_ResetSuccess", {
          target: tr(targetKeyMap[target] ?? target),
        });
      }

      await (client.rest as any).patch(`/guilds/${guild.id}/members/@me`, {
        body,
      });

      const container = new ContainerBuilder();
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(successMsg),
      );

      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [container],
      });
    } catch (e: any) {
      const errMsg = e?.rawError?.message || e?.message || String(e);
      await interaction.editReply(tr("botProfile_Error", { error: errMsg }));
    }
  },
};

export default command;
