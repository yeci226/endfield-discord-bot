
export class GachaApiError extends Error {
  apiCode: number;
  constructor(message: string, apiCode: number) {
    super(message);
    this.name = "GachaApiError";
    this.apiCode = apiCode;
  }
}

export interface GachaRecord {
  kind?: string;
  seqId: string;
  charId?: string;
  charName?: string;
  weaponId?: string;
  weaponName?: string;
  rarity: number;
  gachaTs: string;
  poolId: string;
  poolName: string;
  poolType: string;
  isFree: boolean;
  [key: string]: any;
}
export interface GachaLeaderboardEntry {
  uid: string;
  nickname: string;
  displayName?: string; // Discord display name
  gameNickname?: string;
  avatarUrl?: string; // Discord avatar
  lastUpdate: number;
  total: number;
  nonFreeTotal: number;
  freeTotal: number;
  accountIndex?: number; // 1-indexed account position
  poolNames?: Record<string, string>; // poolId -> poolName mapping
  stats: Record<
    string,
    {
      total: number;
      sixStarCount: number;
      fiveStarCount: number;
      probability: number;
    }
  >;
}

export interface GachaLogData {
  characterList: GachaRecord[];
  weaponList: GachaRecord[];
  info: {
    uid: string;
    lang: string;
    serverId?: string;
    nickname?: string;
    avatarUrl?: string; // Store avatar URL in log data too
    export_timestamp: number;
    // Pity reset boundaries: set when a data gap is detected between the previous
    // import and the current API fetch (records older than 90 days are inaccessible).
    // Pity counters restart from this seqId to prevent inflated/deflated pity readings.
    charPityResetSeqId?: string;
    weaponPityResetSeqId?: string;
  };
}

export interface GachaFingerprintMatch {
  uid: string;
  score: number;
  seqOverlap: number;
  timeSimilarity: number;
  poolSimilarity: number;
}

export interface GachaFingerprintResult {
  recommendedUid?: string;
  confidence: number;
  selectedUid?: string;
  selectedScore?: number;
  compared: number;
  matches: GachaFingerprintMatch[];
  incomingSummary: {
    total: number;
    startTs: number;
    endTs: number;
  };
}

export function isPullFree(record: any): boolean {
  if (!record) return false;
  return (
    record.isFree === true ||
    record.is_free === 1 ||
    record.is_free === true ||
    record.is_free === "1" ||
    record.isFree === "true" ||
    record.isFree === 1
  );
}

export function isGachaPull(record: GachaRecord): boolean {
  // New API records include non-draw events such as gift_intel_book.
  // Legacy draw records predate the kind field and must still be counted.
  return record.kind == null || record.kind === "draw";
}