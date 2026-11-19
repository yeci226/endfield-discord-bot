import {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { getCharacterPool, getWeaponPool } from "../../../utils/skportApi";
import {
  getAccounts,
  withAutoRefresh,
} from "../../../utils/accountUtils";
import { GachaContext } from "./context";
import { extractPoolIconUrls, rememberIconUrls } from "../gachaIconUrls";

/** One banner: title + both end times, then the picture gallery. */
function addPoolBlock(
  container: ContainerBuilder,
  pool: { name: string; poolEndAtTs: number | string },
  items: Array<{ pic?: string }> | undefined,
  tr: any,
) {
  // Asia (UTC+8) - base timestamp from API
  const asiaEndTs = Number(pool.poolEndAtTs);
  // Americas/Europe - roughly 13 hours after Asia if local time is same
  const globalEndTs = asiaEndTs + 13 * 3600;

  const header =
    `## ${pool.name}
` +
    `${tr("gacha_Global_End", { globalEndTs: `<t:${globalEndTs}:f>`, globalEndTsRelative: `<t:${globalEndTs}:R>` })}
` +
    `${tr("gacha_Asia_End", { asiaEndTs: `<t:${asiaEndTs}:f>`, asiaEndTsRelative: `<t:${asiaEndTs}:R>` })}`;

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(2),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(header),
  );

  const gallery = new MediaGalleryBuilder();
  // A media gallery holds at most 10 items.
  for (const item of (items ?? []).slice(0, 10)) {
    if (item.pic) {
      gallery.addItems(
        new MediaGalleryItemBuilder({ media: { url: item.pic } }),
      );
    }
  }
  if (gallery.items.length > 0) {
    container.addMediaGalleryComponents(gallery);
  }
}

export async function handleGachaList(
  ctx: GachaContext,
  interaction: ChatInputCommandInteraction,
) {
  const { client, tr, db } = ctx;

  // Default gacha command logic (display pools)
  await interaction.deferReply({
    flags: MessageFlags.IsComponentsV2 as any,
  });

  try {
    const userId = interaction.user.id;
    const accounts = await getAccounts(db, userId);
    const account = accounts?.[0] || {}; // Use first account for salt if exists

    let charPoolData: any;
    let weaponPoolData: any;

    try {
      if (account.cookie) {
        charPoolData = await withAutoRefresh(
          client,
          userId,
          account,
          (c, s, options) =>
            getCharacterPool(interaction.locale, c, s, options),
          tr.lang,
        );
        weaponPoolData = await withAutoRefresh(
          client,
          userId,
          account,
          (c, s, options) =>
            getWeaponPool(interaction.locale, c, s, options),
          tr.lang,
        );
      } else {
        charPoolData = await getCharacterPool(interaction.locale);
        weaponPoolData = await getWeaponPool(interaction.locale);
      }
    } catch (e: any) {
      if (e.message === "TokenExpired") {
        charPoolData = { code: 10000 };
      } else {
        throw e;
      }
    }

    // The pool lists carry every banner's pictures: remember their ids and URLs
    // as the card renderer's last fallback for icons it has no table entry for.
    try {
      await rememberIconUrls(
        db,
        extractPoolIconUrls(
          charPoolData?.code === 0 ? charPoolData.data?.list : undefined,
          weaponPoolData?.code === 0 ? weaponPoolData.data?.list : undefined,
        ),
      );
    } catch (e) {
      console.error("[Gacha List] could not store icon URLs:", e);
    }

    const container = new ContainerBuilder();

    // Title
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(tr("gacha_Title")),
    );

    // --- Character Pools ---
    if (
      charPoolData &&
      charPoolData.code === 0 &&
      charPoolData.data.list.length > 0
    ) {
      for (const charPool of charPoolData.data.list) {
        addPoolBlock(container, charPool, charPool.chars, tr);
      }
    } else if (charPoolData?.code === 10000) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(tr("TokenExpired")),
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(tr("gacha_CharEmpty")),
      );
    }

    // --- Weapon Pools (fetched above; same layout as the character banners) ---
    // An expired token already said so in the character block.
    if (charPoolData?.code !== 10000) {
      if (
        weaponPoolData &&
        weaponPoolData.code === 0 &&
        weaponPoolData.data.list.length > 0
      ) {
        for (const weaponPool of weaponPoolData.data.list) {
          addPoolBlock(container, weaponPool, weaponPool.weapons, tr);
        }
      } else {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(tr("gacha_WeaponEmpty")),
        );
      }
    }

    await interaction.editReply({
      content: "",
      flags: MessageFlags.IsComponentsV2 as any,
      components: [container],
    });
  } catch (error) {
    console.error("Error in gacha command:", error);
    try {
      if (!(interaction as any).ephemeral) {
        await interaction.deleteReply().catch(() => {});
      }
    } catch {}
    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(tr("UnknownError")),
    );
    await interaction.followUp({
      content: "",
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as any,
      components: [container],
    });
  }
}
