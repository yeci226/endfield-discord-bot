import { GlobalFonts, CanvasRenderingContext2D } from "@napi-rs/canvas";
import path from "path";
import moment from "moment";
import { CustomDatabase } from "../../../utils/Database";
import { GachaLogData } from "../gachaTypes";

// Register Fonts
const fontDir = path.join(__dirname, "../../../assets/fonts");
GlobalFonts.registerFromPath(
  path.join(fontDir, "Noto-Sans-TC-400.woff2"),
  "NotoSans",
);
GlobalFonts.registerFromPath(
  path.join(fontDir, "Noto-Sans-TC-700.woff2"),
  "NotoSansTCBold",
);

export function normalizeGachaText(text: string): string {
  return (text || "")
    .replace(/：/g, " : ")
    .replace(/（/g, " (")
    .replace(/）/g, ") ")
    .replace(/，/g, ", ")
    .replace(/。/g, ". ")
    .replace(/、/g, ", ");
}

export function parseGachaTs(rawTs: any): number {
  if (rawTs == null) return 0;
  if (typeof rawTs === "number") return rawTs;
  if (typeof rawTs === "string" && /^\d+$/.test(rawTs)) {
    return Number(rawTs);
  }
  const parsed = moment(rawTs);
  return parsed.isValid() ? parsed.valueOf() : 0;
}

export function formatSmallGachaTime(rawTs: any): string {
  const ts = parseGachaTs(rawTs);
  if (!ts) return "";
  return moment(ts).format("YY/MM/DD HH:mm");
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill = false,
) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  else ctx.stroke();
}

export type GachaType =
  "limited_char" | "rerun_char" | "standard_char" | "beginner_char" | "weapon";

export const ITEMS_PER_PAGE = 28; // 4 rows × 7 cols

// Win-rate counts for one pity-group summary. Numerator and denominator must
// come from the same per-pool maps (both include free/expedited 6★); mixing in
// the non-free sixStarPullCount pushed the rate above 100%.
export function getWinRateCounts(summary: any): {
  featured: number;
  total: number;
} {
  const sum = (m: any) =>
    Object.values(m || {}).reduce((acc: number, v: any) => acc + (v || 0), 0);
  return {
    featured: sum(summary?.poolFeaturedSixMap),
    total: sum(summary?.poolSixStarPullMap),
  };
}

export function getDetailedPageCount(
  items: any[],
  includesPlaceholder: boolean,
  includesPaddedCard: boolean = false,
): number {
  let effectiveItems = items.length;
  if (includesPlaceholder) effectiveItems += 1;
  if (includesPaddedCard) effectiveItems += 1;
  return Math.max(1, Math.ceil(effectiveItems / ITEMS_PER_PAGE));
}

export function fillDynamicText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  baseFontSize: number,
  bold: boolean = true,
) {
  const normalizedText = (text || "")
    .replace(/：/g, " : ")
    .replace(/，/g, ", ")
    .replace(/。/g, ". ")
    .replace(/、/g, ", ");
  let fontSize = baseFontSize;
  ctx.font = `${bold ? "bold " : ""}${fontSize}px ${bold ? "NotoSansTCBold" : "NotoSans"}`;
  let textWidth = ctx.measureText(normalizedText).width;

  while (textWidth > maxWidth && fontSize > 20) {
    fontSize -= 2;
    ctx.font = `${bold ? "bold " : ""}${fontSize}px ${bold ? "NotoSansTCBold" : "NotoSans"}`;
    textWidth = ctx.measureText(normalizedText).width;
  }

  ctx.fillText(normalizedText, x, y, maxWidth);
}

export function drawOffRateBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number = 22,
  isEn: boolean = false,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (isEn) {
    // Background circle for "L" (LOSE)
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#1e3a8a"; // Deep blue
    ctx.fill();

    // White "L"
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.floor(radius * 1.25)}px NotoSansTCBold`;
    ctx.fillText("L", 0, -1);
  } else {
    // Background circle for "歪"
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ff0000";
    ctx.fill();

    // White "歪"
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.floor(radius * 1.1)}px NotoSansTCBold`;
    ctx.fillText("歪", 0, -2.5);
  }

  ctx.restore();
}

/** One column / pool block of the overview, or the single block of the detail view. */
export interface GachaVisualGroup {
  title: string;
  items: any[];
  gId: string;
  pId?: string;
}

/** Everything known before the summary cards are drawn. */
export interface GachaStatsBaseState {
  data: GachaLogData;
  stats: any;
  tr: any;
  type: GachaType;
  selectedPoolId?: string;
  page: number;
  db?: CustomDatabase;
  apiLang: string;
  apiServerId: string;
  isEn: boolean;
  width: number;
  height: number;
  padding: number;
  baseType: "weapon" | "char";
  history: any[];
  visualGroups: GachaVisualGroup[];
  poolBannerUrlMap: Map<string, string>;
  getPoolPaddedCount: (poolId: string, groupId: string) => number;
  getPoolSixStarSummary: (poolId: string) => any[];
  getPoolLatestGachaTs: (poolId?: string) => any;
  drawBannerContain: (
    img: any,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => void;
}

/** What drawSummary reports back to the orchestrator. */
export interface GachaSummaryResult {
  summaryY: number;
  summaryH: number;
  cardGap: number;
  specificPoolTotal: number;
  specificPoolFree: number;
}

/** The full state handed to drawOverview / drawDetail. */
export interface GachaStatsState extends GachaStatsBaseState {
  listY: number;
  cardGap: number;
  specificPoolTotal: number;
  specificPoolFree: number;
  quickPoolsForOverview: any[];
  hiddenPoolsWithData: any[];
  overviewBottomLimit: number;
}
