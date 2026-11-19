import axios from "axios";
import { CustomDatabase } from "../../utils/Database";
import { mapLocaleToLang } from "../../utils/skportApi";
import { GachaApiError, GachaRecord, isPullFree } from "./gachaTypes";

export type RawFetchedGacha = {
  host: string;
  lang: string;
  serverId: string;
  apiDomain: string;
  inferredUid: string;
  characterList: GachaRecord[];
  weaponList: GachaRecord[];
};

export async function fetchRawGachaFromUrl(
  urlStr: string,
  onProgress?: (message: string) => void,
  locale?: string,
): Promise<RawFetchedGacha> {
  const isRawToken = !urlStr.trimStart().startsWith("http");

  let token: string;
  let lang: string;
  let serverId: string;
  let apiDomain: string;
  let host: string;
  let inferredUid: string;

  if (isRawToken) {
    // New bookmarklet method: raw token pasted directly
    // Token may be full "part1:part2" format — only the first part is needed
    // decodeURIComponent handles browsers that store URL-encoded tokens in sessionStorage
    const rawPart = urlStr.split(":")[0].trim();
    try {
      token = decodeURIComponent(rawPart);
    } catch {
      token = rawPart;
    }
    lang = locale ? mapLocaleToLang(locale) : "en-us";

    // Auto-detect server by trying gryphline (global) first, then hypergryph (CN)
    if (onProgress) onProgress("Detecting server region...");
    const domainCandidates = [
      { domain: "https://ef-webview.gryphline.com", servers: ["3", "2", "1"] },
      { domain: "https://ef-webview.hypergryph.com", servers: ["1"] },
    ];

    let detectedServer: string | null = null;
    let detectedDomain: string | null = null;

    outer: for (const { domain, servers } of domainCandidates) {
      for (const candidate of servers) {
        try {
          const probeRes = await axios.get(`${domain}/api/record/char`, {
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
    inferredUid = host.includes("hypergryph")
      ? `EF_CN_${serverId}`
      : `EF_${serverId}`;
  } else {
    // Legacy URL method (backward compatible)
    const url = new URL(urlStr);
    const rawToken =
      url.searchParams.get("token") || url.searchParams.get("u8_token");
    const rawServerId =
      url.searchParams.get("server_id") || url.searchParams.get("server");

    if (!rawToken || !rawServerId) {
      throw new Error("Invalid URL: Missing token or server_id");
    }

    token = rawToken;
    serverId = rawServerId;
    lang = locale
      ? mapLocaleToLang(locale)
      : url.searchParams.get("lang") || "en-us";
    apiDomain = `${url.protocol}//${url.host}`;
    host = url.host;
    inferredUid = `EF_${serverId}`;
    if (host.includes("hypergryph")) {
      inferredUid = `EF_CN_${serverId}`;
    }
  }

  const characterList: GachaRecord[] = [];
  const weaponList: GachaRecord[] = [];

  // Fetch all character pool types in parallel
  const charResults = await Promise.all(
    POOL_TYPES.map(async (poolType) => {
      const records: GachaRecord[] = [];
      let hasMore = true;
      let lastSeqId: string | undefined = undefined;
      let page = 1;

      while (hasMore) {
        if (onProgress)
          onProgress(
            `Fetching character records (${poolType}, page ${page})...`,
          );

        const res = await axios.get(`${apiDomain}/api/record/char`, {
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

        const list = data.data.list as GachaRecord[];
        if (list && list.length > 0) {
          for (const item of list) {
            item.poolType = poolType;
            item.isFree = isPullFree(item);
            records.push(item);
          }
          lastSeqId = list[list.length - 1].seqId;
        }
        hasMore = data.data.hasMore;
        page++;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      return records;
    }),
  );

  for (const records of charResults) {
    characterList.push(...records);
  }

  if (onProgress) onProgress("Fetching weapon pools...");
  const wpRes = await axios.get(`${apiDomain}/api/record/weapon/pool`, {
    params: { lang, token, server_id: serverId },
  });

  if (wpRes.data.code === 0) {
    const weaponPools = wpRes.data.data;

    // Fetch all weapon pools in parallel
    const weaponResults = await Promise.all(
      weaponPools.map(async (pool: any) => {
        const records: GachaRecord[] = [];
        const poolId = pool.poolId;
        const poolName = pool.poolName;
        let hasMore = true;
        let lastSeqId: string | undefined = undefined;
        let page = 1;

        while (hasMore) {
          if (onProgress)
            onProgress(
              `Fetching weapon records (${poolName}, page ${page})...`,
            );

          const res = await axios.get(`${apiDomain}/api/record/weapon`, {
            params: {
              token,
              lang,
              server_id: serverId,
              pool_id: poolId,
              seq_id: lastSeqId,
            },
          });

          const data = res.data;
          if (data.code !== 0) break;

          const list = data.data.list as GachaRecord[];
          if (list && list.length > 0) {
            for (const item of list) {
              item.poolType = "WeaponPool";
              item.isFree = isPullFree(item);
              records.push(item);
            }
            lastSeqId = list[list.length - 1].seqId;
          }
          hasMore = data.data.hasMore;
          page++;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        return records;
      }),
    );

    for (const records of weaponResults) {
      weaponList.push(...records);
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
    { headers: { "Content-Type": "application/json" } },
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
    { headers: { "Content-Type": "application/json" } },
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
      `https://ef-webview.gryphline.com/api/content?lang=${resolvedLang}&pool_id=${poolId}&server_id=${resolvedServerId}`,
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