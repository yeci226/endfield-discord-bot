import moment from "moment";
import { CustomDatabase } from "../../utils/Database";
import { GachaFingerprintMatch, GachaFingerprintResult, GachaLogData, GachaRecord, isPullFree } from "./gachaTypes";
import { fetchRawGachaFromUrl } from "./gachaApi";

function parseRecordTs(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  const m = moment(v);
  return m.isValid() ? m.valueOf() : 0;
}

function buildPoolDistMap(list: GachaRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of list) {
    if (isPullFree(r)) continue;
    const key = String(r.poolId || "unknown");
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  if (keys.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const av = a.get(k) || 0;
    const bv = b.get(k) || 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function seqOverlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  let hit = 0;
  for (const v of b) {
    if (sa.has(v)) hit++;
  }
  return hit / Math.min(a.length, b.length);
}

function timeWindowSimilarity(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  if (!aStart || !aEnd || !bStart || !bEnd) return 0;
  const centerA = (aStart + aEnd) / 2;
  const centerB = (bStart + bEnd) / 2;
  const spanA = Math.max(1, aEnd - aStart);
  const spanB = Math.max(1, bEnd - bStart);
  const centerDiff = Math.abs(centerA - centerB);
  const spanDiff = Math.abs(spanA - spanB);
  const normCenter = Math.max(spanA, spanB, 1000 * 60 * 60 * 24 * 7);
  const centerScore = Math.max(0, 1 - centerDiff / normCenter);
  const spanScore = Math.max(0, 1 - spanDiff / Math.max(spanA, spanB));
  return centerScore * 0.7 + spanScore * 0.3;
}

export async function analyzeGachaImportFingerprint(
  db: CustomDatabase,
  urlStr: string,
  candidateUids: string[],
  selectedUid?: string,
  locale?: string,
): Promise<GachaFingerprintResult> {
  const raw = await fetchRawGachaFromUrl(urlStr, undefined, locale);
  const incomingList = [...raw.characterList, ...raw.weaponList].sort(
    (a, b) => Number(b.seqId) - Number(a.seqId),
  );

  const incomingSeqs = incomingList.slice(0, 300).map((r) => String(r.seqId));
  const incomingPoolDist = buildPoolDistMap(incomingList);
  const incomingTs = incomingList
    .map((r) => parseRecordTs(r.gachaTs))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const incomingStart = incomingTs[0] || 0;
  const incomingEnd = incomingTs[incomingTs.length - 1] || 0;

  const matches: GachaFingerprintMatch[] = [];
  const uniqueCandidates = Array.from(new Set(candidateUids.filter(Boolean)));

  for (const uid of uniqueCandidates) {
    const existing = await db.get<GachaLogData>(`GACHA_LOG_${uid}`);
    if (!existing) continue;
    const existingList = [
      ...existing.characterList,
      ...existing.weaponList,
    ].sort((a, b) => Number(b.seqId) - Number(a.seqId));
    if (existingList.length === 0) continue;

    const existingSeqs = existingList.slice(0, 300).map((r) => String(r.seqId));
    const seqOverlap = seqOverlapRatio(incomingSeqs, existingSeqs);

    const existingPoolDist = buildPoolDistMap(existingList);
    const poolSimilarity = cosineSimilarity(incomingPoolDist, existingPoolDist);

    const existingTs = existingList
      .map((r) => parseRecordTs(r.gachaTs))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const existingStart = existingTs[0] || 0;
    const existingEnd = existingTs[existingTs.length - 1] || 0;
    const timeSimilarity = timeWindowSimilarity(
      incomingStart,
      incomingEnd,
      existingStart,
      existingEnd,
    );

    const score =
      seqOverlap * 0.55 + poolSimilarity * 0.3 + timeSimilarity * 0.15;

    matches.push({
      uid,
      score,
      seqOverlap,
      timeSimilarity,
      poolSimilarity,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];
  const selected = selectedUid
    ? matches.find((m) => m.uid === selectedUid)
    : undefined;

  return {
    recommendedUid: best?.uid,
    confidence: best?.score || 0,
    selectedUid,
    selectedScore: selected?.score,
    compared: matches.length,
    matches,
    incomingSummary: {
      total: incomingList.length,
      startTs: incomingStart,
      endTs: incomingEnd,
    },
  };
}