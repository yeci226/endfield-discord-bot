import axios from "axios";
import { CustomDatabase } from "../../utils/Database";
import { mapLocaleToLang } from "../../utils/skportApi";
import { GachaApiError, GachaRecord, isPullFree } from "./gachaTypes";

/** Per-request timeout for every call to the game APIs. */
export const GACHA_API_TIMEOUT_MS = 15000;

/**
 * Options added to every axios call here: a hard timeout, and no redirects
 * (an official host that redirects elsewhere must not carry the token along).
 */
export const HTTP_OPTIONS = {
  timeout: GACHA_API_TIMEOUT_MS,
  maxRedirects: 0,
} as const;

/** Auth failures are real errors, never "an incomplete import". */
const AUTH_API_CODES = new Set([40100]);

export const GACHA_GLOBAL_HOST = "ef-webview.gryphline.com";
export const GACHA_CN_HOST = "ef-webview.hypergryph.com";

/** The only hosts an import URL may point at (exact match, https, default port). */
export const GACHA_IMPORT_HOSTS: readonly string[] = [
  GACHA_GLOBAL_HOST,
  GACHA_CN_HOST,
];

export type GachaImportRefusal =
  | "empty"
  | "invalid_url"
  | "not_https"
  | "userinfo"
  | "port"
  | "host_not_allowed"
  | "missing_params"
  | "bad_server";

export type GachaImportTarget =
  | { ok: true; kind: "token"; token: string; apiBase: null }
  | {
      ok: true;
      kind: "url";
      token: string;
      apiBase: string;
      host: string;
      serverId: string;
      lang: string | null;
    }
  | { ok: false; reason: GachaImportRefusal };

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Decides, without any I/O, what an import input is allowed to be:
 * a bare token, or a URL on one of the two official hosts.
 */
export function validateGachaImportUrl(input: string): GachaImportTarget {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };

  if (!URL_SCHEME.test(text)) {
    // Bookmarklet method: raw token. May be "part1:part2"; only part1 is used.
    // decodeURIComponent handles browsers that store URL-encoded tokens.
    const rawPart = text.split(":")[0].trim();
    let token = rawPart;
    try {
      token = decodeURIComponent(rawPart);
    } catch {
      token = rawPart;
    }
    if (!token) return { ok: false, reason: "empty" };
    return { ok: true, kind: "token", token, apiBase: null };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "userinfo" };
  if (url.port) return { ok: false, reason: "port" };
  if (!GACHA_IMPORT_HOSTS.includes(url.hostname)) {
    return { ok: false, reason: "host_not_allowed" };
  }

  const token =
    url.searchParams.get("token") || url.searchParams.get("u8_token");
  const serverId =
    url.searchParams.get("server_id") || url.searchParams.get("server");
  if (!token || !serverId) return { ok: false, reason: "missing_params" };
  if (!/^\d{1,3}$/.test(serverId)) return { ok: false, reason: "bad_server" };

  return {
    ok: true,
    kind: "url",
    token,
    // Built from the validated host, never from the raw input.
    apiBase: `https://${url.hostname}`,
    host: url.hostname,
    serverId,
    lang: url.searchParams.get("lang"),
  };
}

/** Thrown before any request when an import input is not acceptable. */
export class GachaImportUrlError extends Error {
  reason: GachaImportRefusal;
  constructor(reason: GachaImportRefusal) {
    super(`Import URL refused: ${reason}`);
    this.name = "GachaImportUrlError";
    this.reason = reason;
  }
}

export type IncompleteFetch = {
  poolType: string;
  poolId?: string;
  reason: string;
};

export type GachaStopAt = {
  /** Return true for a record that is already stored: paging stops after this page. */
  character?: (seqId: string) => boolean;
  weapon?: (seqId: string) => boolean;
  /**
   * The language the stored names were written in. When the import runs in
   * another language the predicates are ignored (a full fetch renames the
   * records inside the window, an incremental one would not).
   */
  lang?: string;
};

export type RawFetchedGacha = {
  host: string;
  lang: string;
  serverId: string;
  apiDomain: string;
  inferredUid: string;
  characterList: GachaRecord[];
  weaponList: GachaRecord[];
  /** Parts of the history that could not be fetched. Empty = complete. */
  incomplete: IncompleteFetch[];
  /** Which lists were fetched with a stop condition (false = paged to the end). */
  incremental: { character: boolean; weapon: boolean };
};

export type PageResult = { list: GachaRecord[]; hasMore: boolean };

/**
 * Pages one pool until the source says there is no more, or until
 * `stop(seqId)` is true for a record on the page just read (that page is kept
 * whole). Records go into `out` as each page arrives, so a failure on page N
 * still leaves pages 1..N-1 in `out`.
 */
export async function pagePool(
  fetchPage: (lastSeqId: string | undefined, page: number) => Promise<PageResult>,
  out: GachaRecord[],
  opts: {
    tag: (item: GachaRecord) => void;
    stop?: (seqId: string) => boolean;
    delayMs?: number;
  },
): Promise<void> {
  let lastSeqId: string | undefined = undefined;
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const res = await fetchPage(lastSeqId, page);
    const list = res.list;
    hasMore = !!res.hasMore;
    if (list && list.length > 0) {
      let reachedKnown = false;
      for (const item of list) {
        opts.tag(item);
        out.push(item);
        if (opts.stop && opts.stop(String(item.seqId))) reachedKnown = true;
      }
      lastSeqId = list[list.length - 1].seqId;
      if (reachedKnown) hasMore = false;
    }
    page++;
    if (hasMore) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 50));
    }
  }
}

function describeFetchError(e: unknown): string {
  if (e instanceof GachaApiError) return `code ${e.apiCode}`;
  const err = e as any;
  if (err?.code === "ECONNABORTED") return "timeout";
  if (err?.response?.status) return `http ${err.response.status}`;
  return String(err?.message || e).slice(0, 80);
}

function isAuthError(e: unknown): boolean {
  return e instanceof GachaApiError && AUTH_API_CODES.has(e.apiCode);
}

export async function fetchRawGachaFromUrl(
  urlStr: string,
  onProgress?: (message: string) => void,
  locale?: string,
  options?: { stopAt?: GachaStopAt },
): Promise<RawFetchedGacha> {
  const target = validateGachaImportUrl(urlStr);
  if (!target.ok) throw new GachaImportUrlError(target.reason);

  const incomplete: IncompleteFetch[] = [];

  let token: string;
  let lang: string;
  let serverId: string;
  let apiDomain: string;
  let host: string;
  let inferredUid: string;

  if (target.kind === "token") {
    token = target.token;
    lang = locale ? mapLocaleToLang(locale) : "en-us";

    // Auto-detect server by trying gryphline (global) first, then hypergryph (CN)
    if (onProgress) onProgress("Detecting server region...");
    const domainCandidates = [
      { domain: `https://${GACHA_GLOBAL_HOST}`, servers: ["3", "2", "1"] },
      { domain: `https://${GACHA_CN_HOST}`, servers: ["1"] },
    ];

    let detectedServer: string | null = null;
    let detectedDomain: string | null = null;

    outer: for (const { domain, servers } of domainCandidates) {
      for (const candidate of servers) {
        try {
          const probeRes = await axios.get(`${domain}/api/record/char`, {
            ...HTTP_OPTIONS,
            params: {
              token,
              lang,
              server_id: candidate,
              pool_type: POOL_TYPES[0],
            },
          });
          if (probeRes.data.code === 0) {
            detectedServer = candidate;
            detectedDomain = domain;
            break outer;
          }
          // Any non-zero code means this server didn't work — try next
        } catch {
          // Network error — try next candidate
        }
      }
    }

    if (!detectedServer || !detectedDomain) {
      throw new GachaApiError(
        "Unable to import records. Token may be invalid or expired.",
        40100,
      );
    }

    apiDomain = detectedDomain;
    host = detectedDomain.replace("https://", "");
    serverId = detectedServer;
    inferredUid = host === GACHA_CN_HOST ? `EF_CN_${serverId}` : `EF_${serverId}`;
  } else {
    // Legacy URL method (backward compatible), host already validated
    token = target.token;
    serverId = target.serverId;
    lang = locale ? mapLocaleToLang(locale) : target.lang || "en-us";
    apiDomain = target.apiBase;
    host = target.host;
    inferredUid =
      host === GACHA_CN_HOST ? `EF_CN_${serverId}` : `EF_${serverId}`;
  }

  const requestedStop = options?.stopAt;
  const stopAt =
    requestedStop &&
    (requestedStop.lang === undefined || requestedStop.lang === lang)
      ? requestedStop
      : undefined;

  const characterList: GachaRecord[] = [];
  const weaponList: GachaRecord[] = [];

  // Fetch all character pool types in parallel
  const charResults = await Promise.all(
    POOL_TYPES.map(async (poolType) => {
      const records: GachaRecord[] = [];
      try {
        await pagePool(
          async (lastSeqId, page) => {
            if (onProgress)
              onProgress(
                `Fetching character records (${poolType}, page ${page})...`,
              );

            const res = await axios.get(`${apiDomain}/api/record/char`, {
              ...HTTP_OPTIONS,
              params: {
                token,
                lang,
                server_id: serverId,
                pool_type: poolType,
                seq_id: lastSeqId,
              },
            });

            const data = res.data;
            if (data.code !== 0) {
              throw new GachaApiError(
                data.msg || data.message || "API Error",
                data.code,
              );
            }
            return {
              list: (data.data?.list ?? []) as GachaRecord[],
              hasMore: !!data.data?.hasMore,
            };
          },
          records,
          {
            tag: (item) => {
              item.poolType = poolType;
              item.isFree = isPullFree(item);
            },
            stop: stopAt?.character,
          },
        );
        return { records, error: null as unknown };
      } catch (e) {
        if (isAuthError(e)) throw e;
        return { records, error: e };
      }
    }),
  );

  for (let i = 0; i < charResults.length; i++) {
    const { records, error } = charResults[i];
    characterList.push(...records);
    if (error) {
      incomplete.push({
        poolType: POOL_TYPES[i],
        reason: describeFetchError(error),
      });
    }
  }
  // Every character pool failing is a failed import, not a partial one.
  if (incomplete.length === POOL_TYPES.length) {
    const firstError = charResults.find((r) => r.error)!.error;
    throw firstError instanceof Error
      ? firstError
      : new Error(describeFetchError(firstError));
  }

  if (onProgress) onProgress("Fetching weapon pools...");
  let weaponPools: any[] = [];
  try {
    const wpRes = await axios.get(`${apiDomain}/api/record/weapon/pool`, {
      ...HTTP_OPTIONS,
      params: { lang, token, server_id: serverId },
    });
    if (wpRes.data.code === 0 && Array.isArray(wpRes.data.data)) {
      weaponPools = wpRes.data.data;
    } else {
      const code = Number(wpRes.data.code);
      if (AUTH_API_CODES.has(code)) {
        throw new GachaApiError(
          wpRes.data.msg || wpRes.data.message || "API Error",
          code,
        );
      }
      incomplete.push({
        poolType: "WeaponPool",
        reason: `pool list: code ${wpRes.data.code}`,
      });
    }
  } catch (e) {
    if (isAuthError(e)) throw e;
    incomplete.push({
      poolType: "WeaponPool",
      reason: `pool list: ${describeFetchError(e)}`,
    });
  }

  // Fetch all weapon pools in parallel
  const weaponResults = await Promise.all(
    weaponPools.map(async (pool: any) => {
      const records: GachaRecord[] = [];
      const poolId = pool.poolId;
      const poolName = pool.poolName;
      try {
        await pagePool(
          async (lastSeqId, page) => {
            if (onProgress)
              onProgress(
                `Fetching weapon records (${poolName}, page ${page})...`,
              );

            const res = await axios.get(`${apiDomain}/api/record/weapon`, {
              ...HTTP_OPTIONS,
              params: {
                token,
                lang,
                server_id: serverId,
                pool_id: poolId,
                seq_id: lastSeqId,
              },
            });

            const data = res.data;
            if (data.code !== 0) {
              throw new GachaApiError(
                data.msg || data.message || "API Error",
                data.code,
              );
            }
            return {
              list: (data.data?.list ?? []) as GachaRecord[],
              hasMore: !!data.data?.hasMore,
            };
          },
          records,
          {
            tag: (item) => {
              item.poolType = "WeaponPool";
              item.isFree = isPullFree(item);
            },
            stop: stopAt?.weapon,
          },
        );
        return { records, poolId: String(poolId), error: null as unknown };
      } catch (e) {
        if (isAuthError(e)) throw e;
        return { records, poolId: String(poolId), error: e };
      }
    }),
  );

  for (const { records, poolId, error } of weaponResults) {
    weaponList.push(...records);
    if (error) {
      incomplete.push({
        poolType: "WeaponPool",
        poolId,
        reason: describeFetchError(error),
      });
    }
  }

  return {
    host,
    lang,
    serverId,
    apiDomain,
    inferredUid,
    characterList,
    weaponList,
    incomplete,
    incremental: {
      character: !!stopAt?.character,
      weapon: !!stopAt?.weapon,
    },
  };
}

/**
 * Exchange a Gryphline/Hypergryph ACCOUNT_TOKEN for an Endfield u8_token.
 * Requires the user's hgId (stored in account.info.id after /login).
 */
export async function getEndfieldU8Token(
  accountToken: string,
  hgId: string,
  provider: "hypergryph" | "gryphline" = "gryphline",
): Promise<string> {
  const appCode =
    provider === "gryphline" ? "3dacefa138426cfe" : "be36d44aa36bfb5b";

  // hgId here is the Endfield game uid from Skland binding (efRoles[].uid),
  // which is what u8_token_by_uid expects.
  const uid = hgId;
  if (!uid) throw new Error("Unable to resolve Endfield game uid");

  // Step 1: Exchange ACCOUNT_TOKEN → Endfield OAuth token
  const oauthRes = await axios.post(
    `https://as.${provider}.com/user/oauth2/v2/grant`,
    { type: 1, appCode, token: accountToken },
    { ...HTTP_OPTIONS, headers: { "Content-Type": "application/json" } },
  );
  if (oauthRes.data?.status !== 0) {
    throw new GachaApiError(
      `OAuth grant failed: ${oauthRes.data?.msg || "unknown"}`,
      oauthRes.data?.status ?? -1,
    );
  }
  const oauthToken = oauthRes.data?.data?.token;
  if (!oauthToken) throw new Error("No OAuth token in response");

  // Step 2: Exchange uid + oauth_token → u8_token
  const u8Res = await axios.post(
    `https://binding-api-account-prod.${provider}.com/account/binding/v1/u8_token_by_uid`,
    { uid, token: oauthToken },
    { ...HTTP_OPTIONS, headers: { "Content-Type": "application/json" } },
  );
  const u8Status = u8Res.data?.status ?? u8Res.data?.code;
  if (u8Status !== undefined && u8Status !== 0) {
    throw new GachaApiError(
      `u8_token_by_uid failed: ${u8Res.data?.msg || u8Res.data?.message || "unknown"} (code ${u8Status})`,
      u8Status,
    );
  }
  const u8Token = u8Res.data?.data?.token ?? u8Res.data?.data?.u8_token;
  if (!u8Token)
    throw new Error(
      `No u8_token in response (keys: ${Object.keys(u8Res.data?.data || {}).join(", ") || "empty"})`,
    );

  return u8Token;
}

export const POOL_TYPES = [
  "E_CharacterGachaPoolType_Standard",
  "E_CharacterGachaPoolType_Special",
  "E_CharacterGachaPoolType_Joint",
  "E_CharacterGachaPoolType_Rerun",
  "E_CharacterGachaPoolType_Beginner",
];

export async function getPoolMetadata(
  db: CustomDatabase,
  poolId: string,
  lang?: string,
  serverId?: string,
) {
  if (!poolId || poolId === "unknown") return null;
  const cacheKey = `GACHA_POOL_METADATA_${poolId}`;
  const cached = await db.get<{ data: any; lastFetch: number }>(cacheKey);

  if (cached) {
    return cached.data;
  }

  const resolvedLang = lang || "zh-tw";
  const resolvedServerId = serverId || "2";

  try {
    const res = await axios.get(
      `https://${GACHA_GLOBAL_HOST}/api/content?lang=${resolvedLang}&pool_id=${poolId}&server_id=${resolvedServerId}`,
      HTTP_OPTIONS,
    );
    if (res.data?.code === 0 && res.data?.data?.pool) {
      const poolData = res.data.data.pool;
      await db.set(cacheKey, {
        data: poolData,
        lastFetch: Date.now(),
      });
      return poolData;
    }
  } catch (error) {
    console.error(`Failed to fetch pool metadata for ${poolId}:`, error);
  }

  return null;
}
