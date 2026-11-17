import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import path from "path";
import { fetchImage, drawProfileBackground } from "./canvasUtils";
import { ProfileTemplateService } from "../services/ProfileTemplateService";
import type { ProfileTemplate } from "../interfaces/ProfileTemplate";
import type { CardDetail } from "./skportApi";

GlobalFonts.registerFromPath(path.join(__dirname, "../assets/fonts/Noto-Sans-TC-400.woff2"), "PlayerSans");
GlobalFonts.registerFromPath(path.join(__dirname, "../assets/fonts/Noto-Sans-TC-700.woff2"), "PlayerBold");

export interface PlayerRow { label: string; value?: string; icon?: string; cells?: PlayerRow[]; columns?: number; portrait?: boolean; large?: boolean }
export interface PlayerSection { title: string; rows: PlayerRow[]; highlighted?: boolean; icon?: string; compact?: boolean }
export const playerText = (lang: string, tw: string, en: string) => lang === "tw" ? tw : en;
export const numberText = (value: unknown): string => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? String(Math.round(Number(value) * 10) / 10) : "—";
export const progressText = (current: unknown, total: unknown) => `${numberText(current)} / ${numberText(total)}`;
export function moduleVisible(detail: CardDetail, id: string): boolean {
  return detail.config?.modules?.some((m) => m.id === id && m.switch === true) === true;
}

/** Authenticated self-data is not proof that a module is public. */
export function publicProfileDetail(detail: CardDetail): CardDetail {
  const result = { ...detail, chars: Array.isArray(detail.chars) ? detail.chars : [] } as any;
  if (!moduleVisible(detail, "MODULE_CHAR") || detail.config?.charSwitch === false) result.chars = [];
  if (!moduleVisible(detail, "MODULE_REALTIME")) for (const key of ["dungeon", "dailyMission", "weeklyMission", "bpSystem", "seekSuspicion"]) delete result[key];
  if (!moduleVisible(detail, "MODULE_ACHIEVE")) delete result.achieve;
  result.domain = (detail.domain || []).map((domain) => ({
    ...domain,
    settlements: moduleVisible(detail, "MODULE_DOMAIN_BUILD") ? domain.settlements : undefined,
    moneyMgr: moduleVisible(detail, "MODULE_DOMAIN_BUILD") ? domain.moneyMgr : undefined,
    levels: moduleVisible(detail, "MODULE_DOMAIN_EXPLORE") ? domain.levels : undefined,
  }));
  if (!moduleVisible(detail, "MODULE_DOMAIN_BUILD") && !moduleVisible(detail, "MODULE_DOMAIN_EXPLORE")) result.domain = [];
  for (const [key, id] of [["spaceShip", "MODULE_SPACESHIP"], ["crisisContract", "MODULE_CRISIS_CONTRACT"], ["warEchoes", "MODULE_WAR_ECHOES"], ["indieHard", "MODULE_INDIE_HARD"]]) {
    if (!moduleVisible(detail, id) || (["crisisContract", "warEchoes", "indieHard"].includes(key) && detail.config?.standingsSwitch === false)) delete result[key];
  }
  return result;
}

export function roomOperatorName(detail: CardDetail, char: { charId: string; avatarUrl?: string }, lang: string): string {
  const unknown = playerText(lang, "名稱未提供", "Name unavailable");
  if (!moduleVisible(detail, "MODULE_CHAR") || detail.config?.charSwitch === false) return unknown;
  const exact = detail.chars.filter(c => c.id === char.charId || c.charData?.id === char.charId);
  if (exact.length) return exact.length === 1 ? exact[0].charData?.name || unknown : unknown;
  const imageKey = (url?: string) => { try { const u = new URL(url!); return u.hostname + u.pathname; } catch { return undefined; } };
  const key = imageKey(char.avatarUrl);
  const matches = key ? detail.chars.filter(c => [c.charData?.avatarSqUrl, c.charData?.avatarRtUrl].some(u => imageKey(u) === key)) : [];
  return matches.length === 1 ? matches[0].charData?.name || unknown : unknown;
}
const medalRow = (m: NonNullable<CardDetail["achieve"]>["achieveMedals"][number], lang: string): PlayerRow => ({
  label: m.achievementData.name,
  value: `${m.achievementData.cateName || ""}\n${m.isPlated ? playerText(lang, "鍍層", "Trimmed") : `Lv.${m.level}`} · ${playerText(lang, Number(m.obtainTs) > 0 ? "已取得" : "未取得", Number(m.obtainTs) > 0 ? "Obtained" : "Not obtained")}`,
  icon: (m.isPlated ? m.achievementData.platedIcon : m.level >= 3 ? m.achievementData.reforge3Icon : m.level >= 2 ? m.achievementData.reforge2Icon : m.achievementData.initIcon) || m.achievementData.initIcon,
  portrait: true,
});

export function profileSections(detail: CardDetail, page: number, lang: string, domainIndex = 0, medalPage = 0): PlayerSection[] {
  const t = (tw: string, en: string) => playerText(lang, tw, en);
  const unavailable = (id: string) => moduleVisible(detail, id) ? t("尚未解鎖或未提供資料", "Not unlocked or no data provided") : t("未公開或未提供公開設定", "Private or visibility unavailable");
  const icons: Record<string, string> = { MODULE_REALTIME: "realtime", MODULE_DOMAIN_BUILD: "development", MODULE_DOMAIN_EXPLORE: "exploration", MODULE_SPACESHIP: "spaceship", MODULE_ACHIEVE: "medals", MODULE_CRISIS_CONTRACT: "crisisContract", MODULE_WAR_ECHOES: "warEchoes", MODULE_INDIE_HARD: "indieHard" };
  const section = (title: string, id: string, rows: PlayerRow[]): PlayerSection => ({ title, icon: icons[id], compact: !moduleVisible(detail, id) || !rows.length, rows: moduleVisible(detail, id) && rows.length ? rows : [{ label: unavailable(id) }] });
  if (page === 2) {
    const domain = detail.domain?.[domainIndex];
    const settlements: PlayerRow[] = (domain?.settlements || []).map((s) => ({
      label: `${s.name || s.id} · Lv.${numberText(s.level)}`,
      value: `${t("資金", "Funds")} ${progressText(s.remainMoney, s.moneyMax)}\n${t("經驗", "EXP")} ${s.isFinalMaxLevel ? t("已滿級", "Max level") : progressText(s.exp, s.expToLevelUp)}`,
      icon: s.officerCharAvatar,
    }));
    if (domain?.moneyMgr) settlements.unshift({ label: t("地區資金", "Regional funds"), value: progressText(domain.moneyMgr.count, domain.moneyMgr.total) });
    const explore: PlayerRow[] = (domain?.levels || []).map((level) => ({ label: level.name || level.levelId, icon: `asset:${level.levelId}`, columns: 3,
      cells: [
        [t("謎題", "Puzzles"), level.puzzleCount, "puzzle"], [t("寶箱", "Chests"), level.trchestCount, "chest"],
        [t("醚質", "Aurylenes"), level.pieceCount, "aurylene"], [t("協議採錄樁", "Dataloggers"), level.blackboxCount, "datalogger"],
        [t("裝備寶箱", "Equipment chests"), level.equipTrchestCount, "equipment"], [t("收集項目", "Collectibles"), level.trstarCount, "collectible"],
      ].filter(([, p]) => p != null).map(([name, p, icon]) => ({ label: String(name), value: progressText((p as any).count, (p as any).total), icon: `asset:explore-${icon}` })),
    }));
    const roomNames: Record<number, string> = { 0: t("中樞艙", "Control Nexus"), 1: t("製造艙", "Manufacturing Cabin"), 2: t("培養艙", "Growth Chamber"), 5: t("會客室", "Reception Room") };
    const rooms: PlayerRow[] = [];
    for (const room of detail.spaceShip?.rooms || []) {
      if (!(room.type in roomNames)) continue;
      const roomIcons: Record<number, string> = { 0: "control", 1: "manufacture", 2: "growth", 5: "reception" };
      rooms.push({ label: `${roomNames[room.type]} · Lv.${numberText(room.level)}`, icon: `asset:room-${roomIcons[room.type]}`, columns: 3,
        value: room.chars?.length ? undefined : t("尚未進駐", "No operators assigned"),
        cells: (room.chars || []).map(char => ({ label: roomOperatorName(detail, char, lang), portrait: true,
          value: `${t("體力", "Mood")} ${numberText(char.physicalStrength)}\n${t("好感度", "Trust")} ${numberText(char.favorability)}`, icon: char.avatarUrl })),
      });
    }
    return [section(`${t("地區建設", "Regional development")} · ${moduleVisible(detail, "MODULE_DOMAIN_BUILD") ? domain?.name || "—" : "—"}`, "MODULE_DOMAIN_BUILD", settlements), section(t("區域探索", "Regional exploration"), "MODULE_DOMAIN_EXPLORE", explore), section(t("帝江號", "Dijiang"), "MODULE_SPACESHIP", rooms)];
  }
  if (page === 4) {
    const medals = moduleVisible(detail, "MODULE_ACHIEVE") ? detail.achieve?.achieveMedals || [] : [];
    return [section(`${t("勳章收藏", "Medal collection")} · ${medalPage + 1}/${Math.max(1, Math.ceil(medals.length / 12))}`, "MODULE_ACHIEVE",
      medals.length ? [{ label: "", columns: 4, cells: medals.slice(medalPage * 12, medalPage * 12 + 12).map(m => medalRow(m, lang)) }] : [])];
  }

  const rows = [
    { icon: "asset:daily", label: t("每日任務", "Daily activity"), value: progressText(detail.dailyMission?.dailyActivation, detail.dailyMission?.maxDailyActivation) },
    { icon: "asset:realtime", label: t("每週進度", "Weekly routine"), value: progressText(detail.weeklyMission?.score, detail.weeklyMission?.total) },
    { icon: "asset:realtime", label: t("協議通行證", "Protocol Pass"), value: progressText(detail.bpSystem?.curLevel, detail.bpSystem?.maxLevel) },
    { icon: "asset:indieHard", label: t("蝕像尋遺", "Umbral Monument progress"), value: progressText(detail.seekSuspicion?.count, detail.seekSuspicion?.total) },
  ];
  return [section(t("任務與進度", "Activity and progress"), "MODULE_REALTIME", [{ label: "", columns: 2, cells: rows }]),
    section(t("危機合約", "Contingency Contract"), "MODULE_CRISIS_CONTRACT", (detail.crisisContract || []).map((c) => ({ label: c.name || c.id, value: `${t("最高紀錄", "Best result")} ${numberText(c.highest)} · ${t("挑戰次數", "Challenges")} ${numberText(c.challengeCount)}` }))),
    section(t("戰鬥回響", "Echoes of War"), "MODULE_WAR_ECHOES", (detail.warEchoes?.seasons || []).map((s) => ({ label: s.name || s.id, value: `${t("星數", "Stars")} ${numberText(s.stars ?? s.weeks?.reduce((sum, w) => sum + Number(w.stars || 0), 0))}` }))),
    section(t("蝕像尋遺關卡", "Umbral Monument stages"), "MODULE_INDIE_HARD", (detail.indieHard?.indieHardGroups || []).flatMap((g) => (g.dungeonGroups || []).map((d) => ({ label: d.normalDungeon?.name || g.activityName || g.name || g.id, value: `${t("普通", "Normal")}: ${d.normalDungeon?.isPass == null ? "—" : d.normalDungeon.isPass ? t("已通關", "Cleared") : t("未通關", "Not cleared")}   ${t("困難", "Hard")}: ${d.hardDungeon?.isPass == null ? "—" : d.hardDungeon.isPass ? t("已通關", "Cleared") : t("未通關", "Not cleared")}` })))),
    section(t("勳章", "Medals"), "MODULE_ACHIEVE", detail.achieve ? [{ label: t("已取得勳章", "Medals obtained"), value: numberText(detail.achieve.count) }, { label: "", columns: 3, cells: (detail.achieve.achieveMedals || []).filter(m => Number(m.obtainTs) > 0).slice(0, 6).map(m => medalRow(m, lang)) }] : []),
  ];
}


const CARD_WIDTH = 1440, PAD = 40, GAP = 24, HEADER = 230, MAX_HEIGHT = 1800;
const measure = createCanvas(1, 1).getContext("2d");
function lines(value: string, width: number, size: number, bold = false): string[] {
  measure.font = `${size}px ${bold ? "PlayerBold" : "PlayerSans"}`;
  const result: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const char of Array.from(paragraph)) {
      if (line && measure.measureText(line + char).width > width) { result.push(line.trimEnd()); line = ""; }
      line += char;
    }
    result.push(line.trimEnd());
  }
  return result;
}
function rowHeight(row: PlayerRow, width: number, tile = false): number {
  if (row.cells?.length) {
    const columns = row.columns || 3, cellWidth = (width - GAP * (columns - 1)) / columns;
    let height = row.label ? Math.max(40, lines(row.label, width - (row.icon ? 50 : 0), 22, true).length * 28 + 8) : 0;
    for (let i = 0; i < row.cells.length; i += columns) height += Math.max(...row.cells.slice(i, i + columns).map(c => rowHeight(c, cellWidth, true))) + 4;
    return height + 4;
  }
  if (tile && row.portrait) return 64 + lines(row.label, width, 20, true).length * 24 + (row.value ? lines(row.value, width, 18).length * 22 : 0) + 12;
  const iconWidth = row.icon ? tile ? 34 : 90 : 0;
  return Math.max(row.icon ? tile ? 72 : 90 : 0, lines(row.label, width - iconWidth, tile ? 18 : 22, true).length * (tile ? 22 : 28) + (row.value ? lines(row.value, width - iconWidth, row.large ? 44 : tile ? 24 : 20).length * (row.large ? 54 : tile ? 30 : 26) : 0) + 16);
}
function sectionHeight(section: PlayerSection, width: number): number {
  return Math.max(section.icon === "sanity" || section.icon === "daily" ? 100 : 60, lines(section.title, width - 90, 26, true).length * 32 + 20) + section.rows.reduce((h, r) => h + rowHeight(r, width - 32), 0) + 16;
}
export interface PlayerPlacement { section: PlayerSection; x: number; y: number; width: number; height: number; stretch?: number }
export interface PlayerLayout { placements: PlayerPlacement[]; height: number }
/** Measurement and painting use the same font sizes and wrapping; units are whole cards. */
export function layoutPlayerCards(sections: PlayerSection[]): PlayerLayout[] {
  const columnWidth = (CARD_WIDTH - PAD * 2 - GAP) / 2;
  const full = sections.length === 1;
  const width = full ? CARD_WIDTH - PAD * 2 : columnWidth;
  const sorted = sections.map((section, order) => ({ section, order, height: sectionHeight(section, width) })).sort((a, b) => a.height - b.height || a.order - b.order);
  const columns: PlayerSection[][] = full ? [sections, []] : sections.length === 3
    ? [sorted.slice(0, 2).map(s => s.section), [sorted[2].section]]
    : [[], []];
  if (!full && sections.length !== 3) {
    const heights = [0, 0];
    for (const { section } of [...sorted].reverse()) { const col = heights[0] <= heights[1] ? 0 : 1; columns[col].push(section); heights[col] += sectionHeight(section, width) + GAP; }
    if (!columns[0].includes(sections[0])) columns.reverse();
    columns.forEach(group => group.sort((a, b) => sections.indexOf(a) - sections.indexOf(b)));
  }
  const pages: PlayerLayout[] = [{ placements: [], height: HEADER }];
  for (const [column, group] of columns.entries()) {
    let page = 0, y = HEADER;
    for (const section of group) {
      let rows: PlayerRow[] = [];
      const flush = () => {
        if (!rows.length) return;
        const part = { ...section, rows }, height = sectionHeight(part, width);
        pages[page] ||= { placements: [], height: HEADER };
        pages[page].placements.push({ section: part, x: PAD + column * (columnWidth + GAP), y, width, height });
        pages[page].height = Math.max(pages[page].height, y + height + PAD);
        y += height + GAP; rows = [];
      };
      for (const row of section.rows) {
        if (sectionHeight({ ...section, rows: [row] }, width) > MAX_HEIGHT - HEADER - PAD) throw new Error("A single profile card exceeds the page height");
        if (y + sectionHeight({ ...section, rows: [...rows, row] }, width) > MAX_HEIGHT - PAD) { flush(); page++; y = HEADER; }
        rows.push(row);
      }
      flush();
    }
  }
  for (const page of pages.slice(1)) if (page.placements.length === 1) {
    const p = page.placements[0];
    p.x = PAD; p.width = CARD_WIDTH - PAD * 2;
    if (p.section.icon === "exploration") p.section = { ...p.section, rows: p.section.rows.map(r => ({ ...r, columns: 6 })) };
    p.height = sectionHeight(p.section, p.width);
    page.height = p.y + p.height + PAD;
  }
  for (const page of pages) {
    const groups = [page.placements.filter(p => p.x === PAD), page.placements.filter(p => p.x > PAD)];
    if (groups.some(g => !g.length)) continue;
    const bottom = Math.max(...page.placements.map(p => p.y + p.height));
    for (const group of groups) {
      const last = group[group.length - 1], extra = bottom - last.y - last.height;
      if (extra <= 0) continue;
      const expandable = [...group].reverse().find(p => !p.section.compact);
      if (expandable) {
        expandable.height += extra; expandable.stretch = extra;
        group.slice(group.indexOf(expandable) + 1).forEach(p => p.y += extra);
      } else {
        // Keep private status cards compact; distribute only the gaps between them.
        group.forEach((p, i) => p.y += group.length === 1 ? extra : extra * i / (group.length - 1));
      }
    }
  }
  return pages;
}

export async function drawPlayerCard(detail: CardDetail, title: string, sections: PlayerSection[], lang: string, now = Date.now(), template: ProfileTemplate = ProfileTemplateService.getDefaultTemplate(), sheet = 0): Promise<Buffer> {
  sections = sections.map(s => s.icon === "sanity" || s.icon === "daily" ? { ...s, rows: s.rows.map((r, i) => ({ ...r, large: i === 0 })) } : s);
  const pages = layoutPlayerCards(sections), layout = pages[Math.min(Math.max(0, sheet), pages.length - 1)];
  const scale = template.canvas.width / CARD_WIDTH;
  const canvas = createCanvas(template.canvas.width, Math.ceil(Math.max(650, layout.height) * scale)), ctx = canvas.getContext("2d");
  await drawProfileBackground(ctx, canvas.width, canvas.height, template);
  ctx.scale(scale, scale);
  const text = (value: string, x: number, y: number, width: number, size = 22, bold = false, color = "#fff", lineHeight = size + 6) => {
    ctx.font = `${size}px ${bold ? "PlayerBold" : "PlayerSans"}`; ctx.fillStyle = color;
    const wrapped = lines(value, width, size, bold);
    wrapped.forEach((line, i) => ctx.fillText(line, x, y + size + i * lineHeight));
    return wrapped.length * lineHeight;
  };
  const images = new Map<string, Awaited<ReturnType<typeof loadImage>> | null>();
  const sources = new Set<string>([detail.base?.avatarUrl || "asset:../logo"]);
  const collect = (row: PlayerRow) => { if (row.icon) sources.add(row.icon); row.cells?.forEach(collect); };
  for (const p of layout.placements) { if (p.section.icon) sources.add(`asset:${p.section.icon}`); p.section.rows.forEach(collect); }
  // Reuse fetchImage's cache; bounded groups avoid a burst of CDN requests for medal cards.
  const all = [...sources];
  for (let i = 0; i < all.length; i += 8) await Promise.all(all.slice(i, i + 8).map(async source => {
    try {
      const asset = source === "asset:sanity" ? "sanity-icon" : source.slice(6), ext = asset === "sanity-icon" || asset === "daily" ? "svg" : "png";
      images.set(source, source.startsWith("asset:") ? await loadImage(path.join(__dirname, `../assets/player/${asset}.${ext}`)) : await fetchImage(source));
    } catch { images.set(source, null); }
  }));
  const icon = (source: string | undefined, x: number, y: number, size: number) => {
    if (!source) return;
    ctx.fillStyle = source.startsWith("asset:room-") || source.startsWith("asset:explore-") || source === "asset:sanity" || source === "asset:daily" ? "#e7e9e7" : "rgba(0,0,0,0.16)";
    ctx.beginPath(); ctx.roundRect(x, y, size, size, 6); ctx.fill();
    const img = images.get(source);
    if (img) { const ratio = Math.min(size / img.width, size / img.height); ctx.drawImage(img, x + (size - img.width * ratio) / 2, y + (size - img.height * ratio) / 2, img.width * ratio, img.height * ratio); }
  };
  icon(detail.base?.avatarUrl || "asset:../logo", PAD, 28, 100);
  text(title + (pages.length > 1 ? ` · ${sheet + 1}/${pages.length}` : ""), PAD + 124, 25, 1180, 38, true);
  text(`${detail.base?.name || "Endministrator"}  ·  UID ${detail.base?.roleId || "—"}  ·  ${detail.base?.serverName || "—"}`, PAD + 124, 87, 1180, 26, true);
  const format = (stamp: number) => stamp > 0 && Number.isFinite(stamp) ? new Date(stamp).toLocaleString(lang === "tw" ? "zh-TW" : "en-GB", { timeZone: "Asia/Taipei", hour12: false }) + " UTC+8" : "—";
  text(`${playerText(lang, "遊戲存檔時間", "Game saved")}  ${format(Number(detail.base?.saveTime) * 1000)}`, PAD, 158, 1320, 19, false, "#d0d4d7");
  text(`${playerText(lang, "本次查詢時間", "Queried")}  ${format(now)}`, PAD, 189, 1320, 19, false, "#d0d4d7");
  const paintRow = (row: PlayerRow, x: number, y: number, width: number, tile = false, stretch = 0) => {
    if (row.cells?.length) {
      if (row.label) {
        icon(row.icon, x, y, 32);
        y += Math.max(40, text(row.label, x + (row.icon ? 50 : 0), y, width - (row.icon ? 50 : 0), 22, true, "#fff", 28) + 8);
      }
      const cols = row.columns || 3, cellWidth = (width - GAP * (cols - 1)) / cols;
      const bands = Math.ceil(row.cells.length / cols), bandGap = bands > 1 ? stretch / (bands - 1) : 0;
      if (bands === 1) y += stretch / 2;
      for (let i = 0; i < row.cells.length; i += cols) {
        const cells = row.cells.slice(i, i + cols), height = Math.max(...cells.map(c => rowHeight(c, cellWidth, true)));
        cells.forEach((cell, j) => paintRow(cell, x + j * (cellWidth + GAP), y, cellWidth, true)); y += height + 4 + bandGap;
      }
      return;
    }
    if (tile && row.portrait) {
      icon(row.icon, x + (width - 64) / 2, y, 64);
      y += 64;
      y += text(row.label, x, y, width, 20, true, "#fff", 24);
      if (row.value) text(row.value, x, y, width, 18, false, "#e2e4e6", 22);
      return;
    }
    const offset = row.icon ? tile ? 34 : 90 : 0;
    icon(row.icon, x, y + 2, tile ? 26 : 76);
    const h = text(row.label, x + offset, y, width - offset, tile ? 18 : 22, true, "#fff", tile ? 22 : 28);
    if (row.value) text(row.value, x + offset, y + h, width - offset, row.large ? 44 : tile ? 24 : 20, false, "#e2e4e6", row.large ? 54 : tile ? 30 : 26);
  };
  for (const { section, x, y, width, height, stretch = 0 } of layout.placements) {
    // A dark panel separates white information from the unchanged patterned background.
    ctx.fillStyle = section.highlighted ? "rgba(83,94,35,0.92)" : "rgba(23,29,34,0.92)";
    ctx.beginPath(); ctx.roundRect(x, y, width, height, 12); ctx.fill();
    ctx.fillStyle = section.highlighted ? "#e2ee89" : "#dbe5df"; ctx.fillRect(x, y + 17, 4, 30);
    const reminder = section.icon === "sanity" || section.icon === "daily";
    icon(section.icon ? `asset:${section.icon}` : undefined, x + 16, y + 12, reminder ? 64 : 38);
    const heading = Math.max(reminder ? 100 : 60, text(section.title, x + (reminder ? 100 : 70), y + 12, width - (reminder ? 120 : 90), 26, true, "#fff", 32) + 20);
    let rowY = y + heading;
    const rowGap = section.rows.length > 1 ? stretch / (section.rows.length - 1) : 0;
    for (const row of section.rows) {
      paintRow(row, x + 16, rowY, width - 32, false, section.rows.length === 1 ? stretch : 0);
      rowY += rowHeight(row, width - 32) + (section.rows.length === 1 ? stretch : 0);
      if (!section.compact) { ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fillRect(x + 16, rowY - 5, width - 32, 1); }
      rowY += rowGap;
    }
  }
  let output = canvas.toBuffer("image/webp", 85);
  if (output.length > 9 * 1024 * 1024) output = canvas.toBuffer("image/webp", 70);
  if (output.length > 9 * 1024 * 1024) throw new Error("Profile image exceeds the upload limit");
  return output;
}
