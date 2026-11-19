import {
  MessageFlags,
  ActionRowBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import {
  buildSimPoolFromSources,
  loadPityState,
  savePityState,
  simulatePulls,
  drawSimulationImage,
  loadSimPoolRecords,
  FIVE_STAR_PITY_CAP,
  SIX_STAR_PITY_CAP,
  CURRENT_UP_HARD_PITY_CAP,
} from "../../../utils/gachaSimulatorUtils";
import { GachaContext } from "./context";

export function getSimCurrentUpCounterKey(userId: string, poolId: string): string {
  return `simGachaCurrentUp.${userId}.${poolId}`;
}

export function getDisplayedRemainingPulls(cap: number, pity: number): number {
  return Math.max(1, cap - pity);
}

/**
 * The reply text for one simulation result. Used by both the slash command and
 * the "pull again" buttons so the same state always reads the same.
 */
export function buildSimResultContent(
  tr: any,
  poolCfg: { poolName: string; sixStarUp?: unknown; isSpecial: boolean },
  state: {
    sixStarPity: number;
    fiveStarPity: number;
    isGuaranteed: boolean;
    pullsWithoutCurrentUp: number;
  },
): string {
  const currentUpRemain = CURRENT_UP_HARD_PITY_CAP - state.pullsWithoutCurrentUp;
  const hardPityNote = poolCfg.sixStarUp
    ? currentUpRemain <= 1
      ? `\n${tr("gacha_sim_current_up_guarantee_next")}`
      : `\n${tr("gacha_sim_current_up_guarantee_remaining", { remaining: currentUpRemain })}`
    : "";
  const note =
    tr("gacha_sim_note_summary", {
      pity: state.sixStarPity,
      sixRemaining: getDisplayedRemainingPulls(
        SIX_STAR_PITY_CAP,
        state.sixStarPity,
      ),
      fiveRemaining: getDisplayedRemainingPulls(
        FIVE_STAR_PITY_CAP,
        state.fiveStarPity,
      ),
    }) +
    hardPityNote +
    (poolCfg.isSpecial && state.isGuaranteed
      ? `\n${tr("gacha_sim_next_six_rate_up")}`
      : "");
  return tr("gacha_sim_result_content", {
    poolName: poolCfg.poolName,
    note,
  });
}

function isBeginnerSimPool(pool: any): boolean {
  const id = String(pool?.poolId || pool?.id || "").toLowerCase();
  const name = String(pool?.poolName || pool?.name || "").toLowerCase();
  const type = String(pool?.poolType || pool?.type || "").toLowerCase();
  return (
    id.includes("beginner") ||
    id.includes("c_beginner") ||
    name.includes("新手") ||
    type.includes("beginner")
  );
}

function isSpecialSimPool(pool: any): boolean {
  const id = String(pool?.poolId || pool?.id || "").toLowerCase();
  const name = String(pool?.poolName || pool?.name || "").toLowerCase();
  const type = String(pool?.poolType || pool?.type || "").toLowerCase();
  return (
    id.includes("special") ||
    type.includes("special") ||
    name.includes("特選") ||
    name.includes("限定") ||
    name.includes("up")
  );
}

export function orderSimPools(records: any[]): any[] {
  const dedup = new Map<string, any>();
  for (const r of records || []) {
    const poolId = String(r?.poolId || r?.id || "");
    if (!poolId || isBeginnerSimPool(r)) continue;
    const old = dedup.get(poolId);
    if (!old || Number(old.lastSeenTs || 0) <= Number(r?.lastSeenTs || 0)) {
      dedup.set(poolId, r);
    }
  }

  return Array.from(dedup.values()).sort((a, b) => {
    const aSpecial = isSpecialSimPool(a) ? 1 : 0;
    const bSpecial = isSpecialSimPool(b) ? 1 : 0;
    if (aSpecial !== bSpecial) return bSpecial - aSpecial;
    return Number(b?.lastSeenTs || 0) - Number(a?.lastSeenTs || 0);
  });
}

export async function handleSimulate(
  ctx: GachaContext,
  interaction: ChatInputCommandInteraction,
) {
  const { tr, db } = ctx;

  await interaction.deferReply();
  const userId = interaction.user.id;
  const bannerOption = interaction.options.getString("banner");
  const countOption = (interaction.options.getInteger("count") || 10) as
    1 | 10;
  const recs = orderSimPools(await loadSimPoolRecords(db, userId));
  const poolsList: any[] = recs.map((r) => ({
    id: r.poolId,
    name: r.poolName,
    poolType: r.poolType,
    type: r.poolType,
    chars: [],
  }));
  let targetSkPool = poolsList.find((p: any) => p.id === bannerOption);
  if (!targetSkPool && poolsList.length > 0) {
    targetSkPool =
      poolsList.find(
        (p: any) =>
          p.id.includes("special") ||
          String(p.poolType || p.type || "").includes("Special"),
      ) || poolsList[0];
  }
  if (!targetSkPool) {
    await interaction.editReply({
      content: tr("gacha_sim_pool_missing_retry"),
    });
    return;
  }
  const poolCfg = await buildSimPoolFromSources(db, userId, targetSkPool);
  const pityState = await loadPityState(db, userId, poolCfg.pityKey);
  const currentUpCounterKey = getSimCurrentUpCounterKey(
    userId,
    poolCfg.poolId,
  );
  const poolCurrentUpCounter = await db.get<number>(currentUpCounterKey);
  pityState.pullsWithoutCurrentUp = poolCfg.sixStarUp
    ? Math.max(0, Math.min(119, Number(poolCurrentUpCounter) || 0))
    : 0;
  const results = simulatePulls(countOption, pityState, poolCfg);
  await savePityState(db, userId, poolCfg.pityKey, pityState);
  await db.set(currentUpCounterKey, pityState.pullsWithoutCurrentUp);
  const imageBuffer = await drawSimulationImage(results);
  const attachment = new AttachmentBuilder(imageBuffer, {
    name: "gacha_simulate.webp",
  });
  await interaction.editReply({
    content: buildSimResultContent(tr, poolCfg, pityState),
    files: [attachment],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `gacha:sim_pull:${userId}:${poolCfg.poolId}:${poolCfg.pityKey}:1`,
          )
          .setLabel(tr("gacha_sim_pull_once"))
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("🎲"),
        new ButtonBuilder()
          .setCustomId(
            `gacha:sim_pull:${userId}:${poolCfg.poolId}:${poolCfg.pityKey}:10`,
          )
          .setLabel(tr("gacha_sim_pull_ten"))
          .setStyle(ButtonStyle.Primary)
          .setEmoji("🎰"),
      ),
    ],
  });
  return;
}

export async function handleSimPullButton(
  ctx: GachaContext,
  btnInteraction: ButtonInteraction,
  parts: string[],
) {
  const { tr, db } = ctx;

  if (btnInteraction.user.id !== parts[2]) {
    await btnInteraction.reply({
      content: tr("gacha_sim_only_initiator"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await btnInteraction.deferUpdate();
  const simPoolId = parts[3];
  const simPityKey = parts[4];
  const simCount = (parseInt(parts[5], 10) || 10) as 1 | 10;
  const simUserId = parts[2];
  const recs = orderSimPools(await loadSimPoolRecords(db, simUserId));
  const simPoolList = recs.map((r) => ({
    id: r.poolId,
    name: r.poolName,
    poolType: r.poolType,
    type: r.poolType,
    chars: [],
  }));
  const foundSimPool = simPoolList.find((p: any) => p.id === simPoolId);
  if (!foundSimPool) {
    await btnInteraction.followUp({
      content: tr("gacha_sim_pool_missing_ended"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const simCfg = await buildSimPoolFromSources(
    db,
    simUserId,
    foundSimPool,
  );
  const simState = await loadPityState(db, simUserId, simPityKey);
  const simCurrentUpCounterKey = getSimCurrentUpCounterKey(
    simUserId,
    simCfg.poolId,
  );
  const simPoolCurrentUpCounter = await db.get<number>(
    simCurrentUpCounterKey,
  );
  simState.pullsWithoutCurrentUp = simCfg.sixStarUp
    ? Math.max(0, Math.min(119, Number(simPoolCurrentUpCounter) || 0))
    : 0;
  const simRes = simulatePulls(simCount, simState, simCfg);
  await savePityState(db, simUserId, simPityKey, simState);
  await db.set(simCurrentUpCounterKey, simState.pullsWithoutCurrentUp);
  const simImg = await drawSimulationImage(simRes);
  const simFile = new AttachmentBuilder(simImg, {
    name: "gacha_simulate.webp",
  });
  await btnInteraction.editReply({
    content: buildSimResultContent(tr, simCfg, simState),
    files: [simFile],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `gacha:sim_pull:${simUserId}:${simPoolId}:${simPityKey}:1`,
          )
          .setLabel(tr("gacha_sim_pull_once"))
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("🎲"),
        new ButtonBuilder()
          .setCustomId(
            `gacha:sim_pull:${simUserId}:${simPoolId}:${simPityKey}:10`,
          )
          .setLabel(tr("gacha_sim_pull_ten"))
          .setStyle(ButtonStyle.Primary)
          .setEmoji("🎰"),
      ),
    ],
  });
  return;
}
