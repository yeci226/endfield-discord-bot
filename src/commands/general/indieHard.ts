import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { ExtendedClient } from "../../structures/Client";
import { CustomDatabase } from "../../utils/Database";
import { makeRequest } from "../../utils/skportApi";
import {
  getAccounts,
  ensureAccountBinding,
  getPrimaryBindingRole,
} from "../../utils/accountUtils";
import {
  buildIndieHardCard,
  IndieHardGroup,
} from "../../utils/indieHardCanvasUtils";

// Module-level cache: userId -> groups (expires after 10 min)
const groupCache = new Map<string, { groups: IndieHardGroup[]; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;

async function getIndieHard(
  roleId: string,
  serverId: string,
  userId: string,
  locale?: string,
  cred?: string,
  salt?: string,
): Promise<{ indieHardGroups: IndieHardGroup[] } | null> {
  const url =
    "https://zonai.skport.com/api/v1/game/endfield/card/indie-hard";
  const res = await makeRequest<{
    code: number;
    data: { indieHard: { indieHardGroups: IndieHardGroup[] } };
  }>("GET", url, {
    params: { roleId, serverId, userId },
    cred,
    locale,
    salt,
  });
  if (!res || (res as any).code !== 0) return null;
  return (res as any).data?.indieHard ?? null;
}

async function sendGroupCard(
  interaction:
    | ChatInputCommandInteraction
    | StringSelectMenuInteraction,
  groups: IndieHardGroup[],
  groupIndex: number,
) {
  const group = groups[groupIndex];

  let imgBuffer: Buffer;
  try {
    imgBuffer = await buildIndieHardCard(group);
  } catch (err: any) {
    console.error("[indieHard] Canvas error:", err);
    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent("❌ 圖片生成失敗，請稍後再試。"),
    );
    await interaction.editReply({
      flags: (1 << 15) | MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  const attachment = new AttachmentBuilder(imgBuffer, {
    name: "indie-hard.png",
  });

  // Build select menu
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`影拓豐碑:select:${interaction.user.id}`)
    .setPlaceholder("選擇期數")
    .addOptions(
      groups.map((g, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(g.activityName)
          .setValue(String(i))
          .setDefault(i === groupIndex),
      ),
    );

  await interaction.editReply({
    files: [attachment],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        selectMenu,
      ),
    ],
  });
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName("影拓豐碑")
    .setDescription("查看影拓豐碑（獨立困難模式）進度")
    .setDescriptionLocalizations({
      "en-US": "View Indie Hard Mode progress",
    }) as SlashCommandBuilder,

  execute: async (
    client: ExtendedClient,
    interaction:
      | ChatInputCommandInteraction
      | ModalSubmitInteraction
      | StringSelectMenuInteraction,
    tr: any,
    db: CustomDatabase,
  ) => {
    // ── Handle SelectMenu interaction ────────────────────────────────────
    if ((interaction as StringSelectMenuInteraction).isStringSelectMenu?.()) {
      const sel = interaction as StringSelectMenuInteraction;
      if (!sel.customId.startsWith("影拓豐碑:select:")) return;
      await sel.deferUpdate();

      // Retrieve cached data
      const entry = groupCache.get(sel.user.id);
      if (!entry || Date.now() - entry.ts > CACHE_TTL) {
        await sel.editReply({ content: "❌ 資料已過期，請重新使用指令。", components: [] });
        return;
      }
      const idx = parseInt(sel.values[0]) || 0;
      await sendGroupCard(sel as any, entry.groups, idx);
      return;
    }

    if (!(interaction as ChatInputCommandInteraction).isChatInputCommand?.()) return;
    const ci = interaction as ChatInputCommandInteraction;
    await ci.deferReply({ flags: (1 << 15) | MessageFlags.Ephemeral });

    const discordUserId = ci.user.id;
    const accounts = await getAccounts(db, discordUserId);

    if (!accounts || accounts.length === 0) {
      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "❌ 尚未綁定帳號，請先使用 `/login` 登入。",
        ),
      );
      await ci.editReply({
        flags: (1 << 15) | MessageFlags.IsComponentsV2,
        components: [container],
      });
      return;
    }

    const account = accounts[0];
    await ensureAccountBinding(account, discordUserId, db, ci.locale);

    const primary = getPrimaryBindingRole(account.roles);
    if (!primary) {
      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "❌ 找不到綁定的遊戲角色，請重新登入。",
        ),
      );
      await ci.editReply({
        flags: (1 << 15) | MessageFlags.IsComponentsV2,
        components: [container],
      });
      return;
    }

    const { role, binding } = primary;
    const roleId = String(role.roleId || "");
    const serverId = String(role.serverId || "");
    const skUserId = String(binding?.uid || account.info?.id || "");

    let data: { indieHardGroups: IndieHardGroup[] } | null = null;
    try {
      data = await getIndieHard(
        roleId,
        serverId,
        skUserId,
        ci.locale,
        account.cred,
        account.salt,
      );
    } catch (err: any) {
      console.error("[indieHard] API error:", err);
    }

    if (!data || !data.indieHardGroups || data.indieHardGroups.length === 0) {
      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "❌ 無法取得影拓豐碑資料，請稍後再試。",
        ),
      );
      await ci.editReply({
        flags: (1 << 15) | MessageFlags.IsComponentsV2,
        components: [container],
      });
      return;
    }

    // Cache data for select menu
    groupCache.set(discordUserId, { groups: data.indieHardGroups, ts: Date.now() });

    // Show first (most recent) group
    await sendGroupCard(ci as any, data.indieHardGroups, 0);
  },
};

export default command;
