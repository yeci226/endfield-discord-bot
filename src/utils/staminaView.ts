import type { CardDetail } from "./skportApi";

export interface Gauge {
  cur: number;
  max: number;
  /** cur / max, clamped to 0..1 */
  ratio: number;
}

export type SanityState = "full" | "recovering" | "unknown";

export interface SanityView extends Gauge {
  state: SanityState;
  /** Epoch ms when sanity is full again; only set while recovering. */
  fullAtMs?: number;
  /** ms until full; 0 when full; undefined when the API gave no usable maxTs. */
  remainingMs?: number;
}

export interface StaminaView {
  header: { name: string; roleId: string; serverName: string; level?: number; avatarUrl?: string; savedAtMs?: number };
  sanity?: SanityView;
  daily?: Gauge;
  weekly?: Gauge;
  /** Protocol Pass: cur = current level, max = max level. */
  pass?: Gauge;
  /** True when at least one block has data. */
  hasData: boolean;
}

const num = (v: unknown): number => (v == null || v === "" || !Number.isFinite(Number(v)) ? NaN : Number(v));

function gauge(curRaw: unknown, maxRaw: unknown): Gauge | undefined {
  const cur = num(curRaw);
  const max = num(maxRaw);
  if (!(max > 0) || !(cur >= 0)) return undefined;
  return { cur, max, ratio: Math.min(1, cur / max) };
}

/**
 * Maps `card/detail` to what the stamina card shows. Blocks whose source data
 * is missing or unusable are left out instead of being shown as zeros.
 *
 * Reads: dungeon.curStamina / maxStamina / maxTs (epoch seconds),
 * dailyMission.dailyActivation / maxDailyActivation, weeklyMission.score / total,
 * bpSystem.curLevel / maxLevel, base.name / roleId / serverName / level / avatarUrl.
 */
export function buildStaminaView(detail: Partial<CardDetail> | null | undefined, now: number): StaminaView {
  const d = detail || {};
  const base: any = d.base || {};
  const view: StaminaView = {
    header: {
      name: String(base.name ?? ""),
      roleId: String(base.roleId ?? ""),
      serverName: String(base.serverName ?? ""),
      level: Number.isFinite(Number(base.level)) && Number(base.level) > 0 ? Number(base.level) : undefined,
      avatarUrl: typeof base.avatarUrl === "string" && base.avatarUrl ? base.avatarUrl : undefined,
      savedAtMs: num(base.saveTime) > 0 ? num(base.saveTime) * 1000 : undefined,
    },
    hasData: false,
  };

  const g = gauge(d.dungeon?.curStamina, d.dungeon?.maxStamina);
  if (g) {
    const fullAt = num(d.dungeon?.maxTs) * 1000;
    const hasFullAt = fullAt > 0;
    if (g.cur >= g.max || (hasFullAt && fullAt <= now)) {
      // maxTs already passed: the snapshot is older than the recovery, so it is full now.
      view.sanity = { cur: Math.max(g.cur, g.max), max: g.max, ratio: 1, state: "full", remainingMs: 0 };
    } else if (hasFullAt) {
      view.sanity = { ...g, state: "recovering", fullAtMs: fullAt, remainingMs: fullAt - now };
    } else {
      view.sanity = { ...g, state: "unknown" };
    }
  }

  view.daily = gauge(d.dailyMission?.dailyActivation, d.dailyMission?.maxDailyActivation);
  view.weekly = gauge(d.weeklyMission?.score, d.weeklyMission?.total);
  view.pass = gauge(d.bpSystem?.curLevel, d.bpSystem?.maxLevel);
  view.hasData = !!(view.sanity || view.daily || view.weekly || view.pass);
  return view;
}

/** "5h 12m" style; sub-minute remainders round up to 1 minute. */
export function formatDuration(ms: number, hourUnit: string, minuteUnit: string): string {
  const totalMin = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}${hourUnit} ${m}${minuteUnit}` : `${m}${minuteUnit}`;
}

/**
 * One line for the message body. Uses Discord timestamp markup so the full time
 * follows the viewer's own timezone (the image itself can only show a fixed zone).
 */
export function staminaMessageText(view: StaminaView, tr: (key: string, options?: any) => string): string {
  const s = view.sanity;
  if (!s) return "";
  const nums = `${Math.round(s.cur * 10) / 10}/${Math.round(s.max * 10) / 10}`;
  if (s.state === "full") return tr("stamina_MsgFull", { cur_max: nums });
  if (s.state === "recovering" && s.fullAtMs != null) {
    const ts = Math.floor(s.fullAtMs / 1000);
    return tr("stamina_MsgRecovering", { cur_max: nums, clock: `<t:${ts}:t>`, relative: `<t:${ts}:R>` });
  }
  return tr("stamina_MsgUnknown", { cur_max: nums });
}
