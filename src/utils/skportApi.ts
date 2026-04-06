import axios, { AxiosRequestConfig } from "axios";
import crypto from "crypto";
import { UserInfoResponse } from "./UserInfoInterfaces";
import { Logger } from "./Logger";

const logger = new Logger("SkportAPI");

export async function getCardDetail(
  roleId: string,
  serverId: string,
  userId: string,
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<CardDetailResponse | null> {
  const url = "https://zonai.skport.com/api/v1/game/endfield/card/detail";
  return makeRequest<CardDetailResponse>("GET", url, {
    params: {
      roleId,
      serverId,
      userId,
    },
    cred,
    locale,
    salt,
    ...options,
  });
}

/**
 * Formats the Skport Language header based on Discord locale
 * @param locale Discord interaction locale
 * @returns Skport language code (e.g., 'zh_Hant')
 */
export function formatSkLanguage(locale?: string): string {
  const base = locale || "tw";
  if (
    base === "zh-TW" ||
    base === "zh-HK" ||
    base === "tw" ||
    base === "zh_Hant"
  )
    return "zh_Hant";
  if (base === "zh-CN" || base === "cn" || base === "zh_Hans") return "zh_Hans";
  return "en_US";
}

/**
 * Formats the Accept-Language header based on Discord locale
 * @param locale Discord interaction locale (e.g., 'zh-TW', 'en-US')
 * @returns Formatted Accept-Language string
 */
export function formatAcceptLanguage(locale?: string): string {
  const base = locale || "tw";
  if (base.startsWith("zh") || base === "tw") {
    return "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6";
  }
  return `${base},en;q=0.9`;
}

/**
 * Maps Discord/bot locale to Gryphline API 'lang' parameter
 * @param locale Bot locale (tw, en)
 * @returns API compatible language code (zh-tw, en-us)
 */
export function mapLocaleToLang(locale?: string): string {
  const base = locale || "tw";
  if (
    base === "zh-TW" ||
    base === "zh-HK" ||
    base === "tw" ||
    base === "zh_Hant"
  ) {
    return "zh-tw";
  }
  if (base === "zh-CN" || base === "cn" || base === "zh_Hans") {
    return "zh-cn";
  }
  return "en-us";
}

// Interfaces for API Responses
export interface GameRole {
  serverId: string;
  roleId: string;
  nickname: string;
  level: number;
  isDefault: boolean;
  isBanned: boolean;
  serverType: string;
  serverName: string;
}

export interface GameBinding {
  appCode: string;
  appName: string;
  bindingList: {
    uid: string;
    isOfficial: boolean;
    isDefault: boolean;
    channelMasterId: string;
    channelName: string;
    nickName: string;
    isDelete: boolean;
    gameName: string;
    gameId: number;
    roles: GameRole[];
    defaultRole: GameRole;
  }[];
}

export interface AttendanceReward {
  awardId: string;
  available: boolean;
  done: boolean;
}

export interface ResourceInfo {
  id: string;
  count: number;
  name: string;
  icon: string;
}

export interface AwardId {
  id: string;
}

export interface AttendanceResponse {
  currentTs: string;
  calendar: AttendanceReward[];
  first: AttendanceReward[];
  resourceInfoMap: Record<string, ResourceInfo>;
  hasToday: boolean;
  awardIds?: AwardId[];
}

// Enums Interfaces
export interface SkEnumItem {
  key: string;
  value: string;
}

export interface SkEnumsData {
  rarities: SkEnumItem[];
  professions: SkEnumItem[];
  charProperties: SkEnumItem[];
  weaponTypes: SkEnumItem[];
  skillTypes: SkEnumItem[];
  skillProperties: SkEnumItem[];
  labelTypes: SkEnumItem[];
  equipRarities: SkEnumItem[];
  equipTypes: SkEnumItem[];
  equipLevels: SkEnumItem[];
  activeEffectTypes: SkEnumItem[];
  passiveEffectTypes: SkEnumItem[];
  equipProperties: SkEnumItem[];
  equipAbilities: SkEnumItem[];
  suitTypes: SkEnumItem[];
}

export interface SkEnumsResponse {
  code: number;
  message: string;
  timestamp: string;
  data: SkEnumsData;
}

// Card Detail Interfaces
export interface CardUserInfo {
  serverName: string;
  roleId: string;
  name: string;
  createTime: string;
  saveTime: string;
  lastLoginTime: string;
  exp: number;
  level: number;
  worldLevel: number;
  gender: number;
  avatarUrl: string;
  mainMission: {
    id: string;
    description: string;
  };
  charNum: number;
  weaponNum: number;
  docNum: number;
}

export interface SkillDescParam {
  level: string;
  params: Record<string, string>;
}

export interface CardSkill {
  id: string;
  name: string;
  type: SkEnumItem;
  property: SkEnumItem;
  iconUrl: string;
  desc: string;
  descParams: Record<string, string>;
  descLevelParams: Record<string, SkillDescParam>;
}

export interface CardCharData {
  id: string;
  name: string;
  avatarSqUrl: string;
  avatarRtUrl: string;
  rarity: SkEnumItem;
  profession: SkEnumItem;
  property: SkEnumItem;
  weaponType: SkEnumItem;
  skills: CardSkill[];
  illustrationUrl: string;
  tags: string[];
}

export interface UserSkillInfo {
  skillId: string;
  level: number;
  maxLevel: number;
}

export interface EquipSuit {
  id: string;
  name: string;
  skillId: string;
  skillDesc: string;
  skillDescParams: Record<string, string>;
}

export interface CardEquipData {
  id: string;
  name: string;
  iconUrl: string;
  rarity: SkEnumItem;
  type: SkEnumItem;
  level: SkEnumItem;
  properties: string[];
  isAccessory: boolean;
  suit?: EquipSuit;
  function?: string;
  pkg?: string;
}

export interface CardEquip {
  equipId: string;
  equipData: CardEquipData;
}

export interface CardTacticalItemData {
  id: string;
  name: string;
  iconUrl: string;
  rarity: SkEnumItem;
  activeEffectType: SkEnumItem;
  activeEffect: string;
  passiveEffect: string;
  activeEffectParams: Record<string, string>;
  passiveEffectParams: Record<string, string>;
}

export interface CardTacticalItem {
  tacticalItemId: string;
  tacticalItemData: CardTacticalItemData;
}

export interface WeaponSkill {
  key: string;
  value: string;
}

export interface CardWeaponData {
  id: string;
  name: string;
  iconUrl: string;
  rarity: SkEnumItem;
  type: SkEnumItem;
  function: string;
  description: string;
  skills: WeaponSkill[];
}

export interface CardWeapon {
  weaponData: CardWeaponData;
  level: number;
  refineLevel: number;
  breakthroughLevel: number;
  gem: any; // Using any for null/unknown structure for now
}

export interface CardChar {
  charData: CardCharData;
  id: string;
  level: number;
  userSkills: Record<string, UserSkillInfo>;
  bodyEquip?: CardEquip;
  armEquip?: CardEquip;
  firstAccessory?: CardEquip;
  tacticalItem?: CardTacticalItem;
  evolvePhase: number;
  potentialLevel: number;
  weapon?: CardWeapon;
  gender: string;
  ownTs: string;
}

export interface CardDungeon {
  curStamina: string;
  maxStamina: string;
  maxTs: string;
}

export interface CardAchieveMedalData {
  id: string;
  name: string;
  initIcon: string;
  reforge2Icon: string;
  reforge3Icon: string;
  platedIcon: string;
  cateName: string;
  canCertify: boolean;
  cate: string;
  initLevel: number;
}

export interface CardAchieveMedal {
  achievementData: CardAchieveMedalData;
  level: number;
  isPlated: boolean;
  obtainTs: string;
}

export interface CardAchieve {
  achieveMedals: CardAchieveMedal[];
  display: Record<string, string>;
  count: number;
}

export interface CardDailyMission {
  dailyActivation: number;
  maxDailyActivation: number;
}

export interface CardWeeklyMission {
  score: number;
  total: number;
}

export interface CardBpSystem {
  curLevel: number;
  maxLevel: number;
}

export interface CardDetail {
  base: CardUserInfo;
  chars: CardChar[];
  dungeon: CardDungeon;
  dailyMission: CardDailyMission;
  weeklyMission?: CardWeeklyMission;
  bpSystem: CardBpSystem;
  achieve?: CardAchieve;
}

export interface CardDetailResponse {
  code: number;
  message: string;
  timestamp: string;
  data: {
    detail: CardDetail;
  };
}

export async function getUserInfo(
  cred: string,
  locale?: string,
  salt?: string,
): Promise<UserInfoResponse | null> {
  const url = "https://zonai.skport.com/web/v2/user";
  return makeRequest<UserInfoResponse>("GET", url, {
    cred,
    locale,
    salt,
  });
}

/**
 * Calls web/v1/user/check which the Skland browser uses after login.
 * Helper to construct the sk-game-role header value
 */
export function formatSkGameRole(
  gameId: number,
  roleId: string,
  serverId: string,
): string {
  return `${gameId}_${roleId}_${serverId || ""}`;
}

// Server time offset (in seconds) to compensate for clock skew causing 10003 errors.
let serverTimeOffsetSeconds = 0;

function getAdjustedTimestamp(): string {
  return Math.floor(Date.now() / 1000 + serverTimeOffsetSeconds).toString();
}

// Core Helper
function getCommonHeaders(cred: string | undefined, locale?: string) {
  const timestamp = getAdjustedTimestamp();
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    accept: "*/*",
    "accept-language": formatAcceptLanguage(locale),
    "accept-encoding": "gzip, deflate, br",
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    cred: cred,
    platform: "3",
    "sk-language": formatSkLanguage(locale),
    timestamp: timestamp,
    vname: "1.0.0",
    origin: "https://game.skport.com",
    referer: "https://game.skport.com/",
    priority: "u=1, i",
  };
}

// Interfaces for API Responses
export function generateSign(
  path: string,
  query: string,
  timestamp: string,
  providedSalt?: string,
): string {
  const salt = providedSalt || process.env.SKPORT_SALT || "";
  const s = `${path}${query}${timestamp}${salt}`;
  return crypto.createHash("md5").update(s).digest("hex");
}

export function generateSignV2(
  path: string,
  content: string,
  timestamp: string,
  platform: string,
  vName: string,
  dId: string = "",
  providedSalt?: string,
): string {
  // V2 Salt: Use provided salt (token from generate_cred_by_code or refresh) or fallback
  const salt = providedSalt || process.env.SKPORT_SALT_V2 || "";
  // Construct JSON header string (mimicking specific order and no spaces)
  // Standard Skland V2 signature expects platform, timestamp, dId, vName in this order
  // NOTE: Even if header is 'vname', JSON string MUST use 'vName'
  const headerJson = `{"platform":"${platform}","timestamp":"${timestamp}","dId":"${dId}","vName":"${vName}"}`;

  const s = `${path}${content}${timestamp}${headerJson}`;
  const hmac = crypto.createHmac("sha256", salt).update(s).digest("hex");
  return crypto.createHash("md5").update(hmac).digest("hex");
}

/**
 * Exchanges the existing 'cred' for a new 'token' (salt).
 */
export async function refreshSkToken(
  cred: string,
  platform: string = "3",
  salt?: string,
): Promise<string | null> {
  const url = "https://zonai.skport.com/web/v1/auth/refresh";
  const res = await makeRequest<any>("GET", url, {
    cred,
    salt,
    params: { platform },
  });

  if (res && (res.code === 0 || res.status === 0) && res.data?.token) {
    return res.data.token;
  }
  return null;
}

/**
 * Refreshes the Gryphline ACCOUNT_TOKEN cookie via the web-api.
 */
export async function refreshAccountToken(
  cookie: string,
): Promise<string | null> {
  const url = "https://web-api.skport.com/cookie_store/account_token";
  try {
    const response = await axios.get(url, {
      headers: {
        Accept: "application/json",
        Cookie: cookie,
        Origin: "https://game.skport.com",
        Referer: "https://game.skport.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "x-language": "zh-tw",
        "sec-fetch-site": "same-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
    });

    if (response.data?.code === 0 && response.data?.data?.content) {
      return response.data.data.content;
    }
    return null;
  } catch (error: any) {
    console.error("[Skport] refreshAccountToken failed:", error.message);
    return null;
  }
}

/**
 * Chained refresh for Skport tokens.
 * Handles ACCOUNT_TOKEN (cookie) -> cred -> salt chain.
 */
export async function ensureValidTokens(
  userId: string,
  db: any,
  options: {
    cookie?: string;
    cred?: string;
    salt?: string;
    platform?: string;
  } = {},
): Promise<{ cred: string; salt: string } | null> {
  const platform = options.platform || "3";
  let currentCookie = options.cookie;
  let currentCred = options.cred;

  // 1. If we don't have a cookie or it's potentially stale, try to refresh it
  if (!currentCookie) {
    const rawCookie = await db.get(`${userId}.cookie`);
    if (rawCookie) {
      const refreshedAccountToken = await refreshAccountToken(rawCookie);
      if (refreshedAccountToken) {
        currentCookie = `ACCOUNT_TOKEN=${refreshedAccountToken}`;
      } else {
        currentCookie = rawCookie;
      }
    }
  }

  // 2. If cred is missing or 401 occurred, refresh cred using OAuth
  if (!currentCred && currentCookie) {
    const match = currentCookie.match(/ACCOUNT_TOKEN=([^;\s]+)/);
    const accountToken = match ? match[1] : null;

    if (accountToken) {
      const grantRes = await grantOAuthCode(accountToken);
      if (grantRes && grantRes.status === 0 && grantRes.data?.code) {
        const credRes = await generateCredByCode(grantRes.data.code);
        if (credRes && credRes.code === 0 && credRes.data?.cred) {
          currentCred = credRes.data.cred;
        }
      }
    }
  }

  // 3. Refresh Salt using Cred
  if (currentCred) {
    const newSalt = await refreshSkToken(currentCred, platform, options.salt);
    if (newSalt) {
      return { cred: currentCred, salt: newSalt };
    }
  }

  return null;
}

export async function makeRequest<T>(
  method: "GET" | "POST",
  url: string,
  options: {
    locale?: string;
    headers?: Record<string, string>;
    params?: any;
    data?: any;
    cred?: string;
    salt?: string;
    onStale?: (options: any) => Promise<boolean>;
  } = {},
): Promise<T | null> {
  const execute = async () => {
    const commonHeaders = getCommonHeaders(options.cred, options.locale);
    const headers: any = { ...commonHeaders, ...options.headers };

    // Handle Gryphline specific headers
    if (url.includes("gryphline.com")) {
      headers["x-language"] = mapLocaleToLang(options.locale);
    }

    // Clean up undefined or empty headers
    Object.keys(headers).forEach((key) => {
      if (headers[key] === undefined || headers[key] === "")
        delete headers[key];
    });

    if (method === "POST") {
      headers["content-type"] = "application/json";
    }

    // Generate signature
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    let searchParams = new URLSearchParams(urlObj.search);

    if (options.params) {
      Object.entries(options.params).forEach(([key, val]) => {
        if (val !== undefined && val !== null) {
          searchParams.append(key, String(val));
        }
      });
    }

    const queryString = searchParams.toString();
    const bodyString = options.data
      ? typeof options.data === "string"
        ? options.data
        : JSON.stringify(options.data)
      : "";

    // All skport.com endpoints use V2 sign (HMAC-MD5) with dId="".
    // Gryphline endpoints don't use skport sign at all.
    const useV2 = url.includes("skport.com");

    const signContent = method === "POST" ? bodyString : queryString;

    const sign = useV2
      ? generateSignV2(
          pathname,
          signContent,
          headers.timestamp,
          headers.platform,
          headers.vname || "1.0.0",
          "",
          options.salt,
        )
      : generateSign(pathname, queryString, headers.timestamp, options.salt);

    headers.sign = sign;

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        params: options.params,
        data: options.data,
      };
      const response = await axios(config);
      return response.data;
    } catch (error: any) {
      const resp = error.response;
      if (resp?.status !== 404) {
        if (resp?.status === 401) {
          logger.warn(`[401 Unauthorized] URL: ${url} | body: ${JSON.stringify(resp?.data)}`);
          // code 10003 = server rejects our timestamp (clock skew). Calibrate offset.
          if (resp?.data?.code === 10003 && resp?.data?.timestamp) {
            const serverTs = parseInt(resp.data.timestamp, 10);
            const localTs = Math.floor(Date.now() / 1000);
            const newOffset = serverTs - localTs;
            if (Math.abs(newOffset - serverTimeOffsetSeconds) > 2) {
              serverTimeOffsetSeconds = newOffset;
              logger.warn(`[10003] 校正伺服器時間偏移: ${newOffset}s (本地=${localTs}, 伺服器=${serverTs})`);
            }
          }
          return { code: 10000, status: 401, ...(resp?.data || {}) };
        } else if (resp?.status === 403) {
          const role = headers?.["sk-game-role"] || "-";
          const msg =
            resp?.data?.message || "Identity blocked or WAF triggered.";
          logger.error(
            `[403 Forbidden] ${method} ${url} role=${role} - ${msg}`,
          );
          return {
            code: -1,
            status: 403,
            isBlocked: true,
            ...(resp?.data || {}),
          };
        } else {
          logger.error(`Error requesting ${url}: ${error}`);
        }
      }
      return resp?.data || null;
    }
  };

  let result: any = await execute();

  // Retry once on clock-skew error (10003) — offset was just calibrated above.
  if (result && result.code === 10003 && !(options as any)._isRetrying) {
    (options as any)._isRetrying = true;
    logger.info(`[10003] 以校正後時間重試請求: ${url}`);
    result = await execute();
  }

  // Retry on genuine token expiry (code 10000).
  const isStale = result && result.code === 10000;
  const isBlocked = result && result.status === 403;

  if (
    isStale &&
    !isBlocked &&
    options.onStale &&
    !(options as any)._isRetrying
  ) {
    logger.info(
      `Stale token (Code ${result.code}, HTTP ${result.status}) detected. Attempting refresh...`,
    );
    // Mark as retrying to prevent infinite recursion
    (options as any)._isRetrying = true;
    const refreshed = await options.onStale(options);
    if (refreshed) {
      logger.info(`Refresh successful. Retrying request to ${url}...`);
      result = await execute();
    }
  }

  return result;
}

// Pool Interfaces
export interface SkPoolItem {
  id: string;
  name: string;
  poolStartAtTs: number;
  poolEndAtTs: number;
  chars: Array<{
    name: string;
    pic: string;
  }>;
  weapons: Array<{
    name: string;
    pic: string;
  }>;
}

export interface SkPoolResponse {
  code: number;
  message: string;
  data: {
    list: SkPoolItem[];
  };
}

/**
 * Gryphline OAuth Grant to get exchange code
 */
export async function grantOAuthCode(
  token: string,
  appCode: string = "6eb76d4e13aa36e6",
  type: number = 0,
  locale?: string,
) {
  const url = "https://as.gryphline.com/user/oauth2/v2/grant";
  return makeRequest<any>("POST", url, {
    locale,
    headers: {
      "sec-fetch-site": "cross-site",
      referrer: "https://www.skport.com/",
    },
    data: {
      token: token,
      appCode: appCode,
      type: type,
    },
  });
}

/**
 * Skport Credential Generation using OAuth code
 */
async function generateCredByCode(code: string, locale?: string) {
  const url = "https://zonai.skport.com/web/v1/user/auth/generate_cred_by_code";
  const res = await makeRequest<any>("POST", url, {
    locale,
    headers: {
      platform: "3",
      referrer: "https://www.skport.com/",
      origin: "https://www.skport.com",
      "sec-ch-ua":
        '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
      priority: "u=1, i",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
    },
    data: {
      code,
      kind: 1,
    },
  });
  return res;
}

export async function verifyToken(cookie: string, locale?: string) {
  // 1. Extract raw token value regardless of input format (raw value or full cookie)
  let cleanToken = cookie.trim();

  // If it's a cookie string, extract ACCOUNT_TOKEN
  const match = cleanToken.match(/ACCOUNT_TOKEN=([^;\s]+)/);
  if (match) {
    cleanToken = match[1];
  } else if (cleanToken.includes("ACCOUNT_TOKEN=")) {
    // Handling cases where it might be slightly malformed but contains the key
    const parts = cleanToken.split("ACCOUNT_TOKEN=");
    if (parts.length > 1) {
      cleanToken = parts[1].split(";")[0];
    }
  } else if (cleanToken.includes("=")) {
    // If it has '=' but no ACCOUNT_TOKEN, it's likely an invalid cookie string for our purposes
    // We should only use it if we are sure it's meant to be the raw token
    // For safety, if it looks like a full cookie but lacks ACCOUNT_TOKEN, we log it
    if (cleanToken.includes(";")) {
      logger.warn(
        `Potential invalid cookie provided to verifyToken: ${cleanToken}`,
      );
      // Try to take the first part if it's not a known WAF cookie
      const firstPart = cleanToken.split(";")[0];
      if (!firstPart.startsWith("acw_tc=")) {
        cleanToken = firstPart.split("=")[1] || firstPart;
      }
    }
  }

  // Ensure we have a decoded version
  try {
    const decoded = decodeURIComponent(cleanToken);
    if (decoded !== cleanToken) cleanToken = decoded;
  } catch (e) {}

  // 1. Get Basic Info from Gryphline
  // The Gryphline API only needs the raw ACCOUNT_TOKEN value in the query param.
  const basicUrl = `https://as.gryphline.com/user/info/v1/basic?token=${encodeURIComponent(cleanToken)}`;

  const basicResult = await (async () => {
    try {
      const response = await axios.get(basicUrl, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "sec-fetch-site": "cross-site",
        },
      });
      return response.data;
    } catch (error: any) {
      console.error(`Error requesting ${basicUrl}:`, error.message);
      return null;
    }
  })();

  if (!basicResult || basicResult.status !== 0) {
    // If it's a 400 error, it likely means the token itself is invalid (e.g. passed a cookie string or JSON)
    if (basicResult?.status === 400) {
      logger.warn(
        `Gryphline API 400 for token: ${cleanToken.substring(0, 10)}...`,
      );
    }
    return basicResult; // Error or null
  }

  // 2. Grant OAuth Code
  const grantResult = await grantOAuthCode(cleanToken, undefined, 0, locale);
  if (grantResult && grantResult.status === 0 && grantResult.data?.code) {
    const code = grantResult.data.code;

    // 3. Generate Skport Cred
    const credResult = await generateCredByCode(code, locale);
    if (credResult && credResult.code === 0 && credResult.data?.cred) {
      return {
        ...basicResult,
        cred: credResult.data.cred,
        token: credResult.data.token,
      };
    }
  }

  return basicResult; // Return basic info even if cred exchange fails (fallback)
}

export async function getCharacterPool(
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<SkPoolResponse | null> {
  const url = "https://zonai.skport.com/web/v1/wiki/char-pool";
  return makeRequest("GET", url, {
    locale,
    cred,
    salt,
    headers: {
      authority: "zonai.skport.com",
      origin: "https://www.skport.com",
      referer: "https://wiki.skport.com/",
    },
    ...options,
  });
}

export async function getGamePlayerBinding(
  cookie: string | undefined,
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<GameBinding[] | null> {
  const res = await getGamePlayerBindingResponse(cookie, locale, cred, salt, options);
  if (res && res.code === 0 && res.data?.list) {
    return res.data.list;
  }
  return null;
}

export async function getGamePlayerBindingResponse(
  _cookie: string | undefined,
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<{ code: number; status?: number; data?: { list: GameBinding[] } } | null> {
  const url = "https://zonai.skport.com/api/v1/game/player/binding";
  // Do NOT send Cookie header — the browser doesn't and the WAF blocks requests that do.
  // cred+sign authentication is sufficient.
  return makeRequest<{
    code: number;
    data: { list: GameBinding[] };
  }>("GET", url, {
    locale,
    cred,
    salt,
    ...options,
  });
}

export async function getWeaponPool(
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<SkPoolResponse | null> {
  const url = "https://zonai.skport.com/web/v1/wiki/weapon-pool";
  return makeRequest("GET", url, {
    locale,
    cred,
    salt,
    headers: {
      authority: "zonai.skport.com",
      origin: "https://www.skport.com",
      referer: "https://wiki.skport.com/",
    },
    ...options,
  });
}

export async function getAttendanceList(
  gameId: number,
  roleId: string,
  gameRole: string,
  cookie: string | undefined,
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<{ code: number; data: AttendanceResponse } | null> {
  const isArknights = gameId === 1;
  const url = isArknights
    ? "https://zonai.skport.com/api/v1/game/attendance"
    : "https://zonai.skport.com/web/v1/game/endfield/attendance";
  const headers: any = isArknights
    ? {}
    : {
        "sk-game-role": gameRole,
      };
  if (cookie) headers.Cookie = cookie;

  const res = await makeRequest<{ code: number; data: AttendanceResponse }>(
    "GET",
    url,
    {
      locale,
      cred,
      salt,
      params: isArknights ? { gameId, uid: roleId } : undefined,
      headers,
      ...options,
    },
  );
  return res;
}

export async function getAttendanceRecords(
  gameRole: string,
  cookie: string | undefined,
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<{ code: number; data: any } | null> {
  const url = "https://zonai.skport.com/web/v1/game/endfield/attendance/record";
  const headers: any = {
    "sk-game-role": gameRole,
    Referer: "https://game.skport.com/",
    Origin: "https://game.skport.com",
    vname: "1.0.0",
    vName: undefined,
    priority: "u=1, i",
  };
  if (cookie) headers.Cookie = cookie;

  const res = await makeRequest<{ code: number; data: any }>("GET", url, {
    locale,
    cred,
    salt,
    headers,
    ...options,
  });
  return res;
}

export async function executeAttendance(
  gameId: number,
  roleId: string,
  gameRole: string,
  cookie: string | undefined,
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<{ code: number; message: string; data?: AttendanceResponse }> {
  const isArknights = gameId === 1;
  const url = isArknights
    ? "https://zonai.skport.com/api/v1/game/attendance"
    : "https://zonai.skport.com/web/v1/game/endfield/attendance";
  const body = isArknights ? { uid: roleId } : { role: gameRole };
  const headers: any = isArknights
    ? {
        Accept: "*/*",
        Origin: "https://game.skport.com",
        Referer: "https://game.skport.com/",
        vname: "1.0.0",
      }
    : {
        "sk-game-role": gameRole,
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        Connection: "keep-alive",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        Origin: "https://game.skport.com",
        Referer: "https://game.skport.com/",
        vname: "1.0.0",
      };
  if (cookie) headers.Cookie = cookie;

  const res = await makeRequest<{
    code: number;
    message: string;
    status?: number;
    data?: AttendanceResponse;
  }>("POST", url, {
    locale,
    cred,
    salt,
    headers,
    data: body,
    ...options,
  });

  return res || { code: -1, message: "Request failed" };
}

export async function getEnums(
  cred?: string,
  locale?: string,
  salt?: string,
  options: any = {},
): Promise<SkEnumsResponse | null> {
  const url = "https://zonai.skport.com/web/v1/game/endfield/enums";
  return makeRequest("GET", url, {
    locale,
    cred,
    salt,
    headers: {
      referrer: "https://game.skport.com/",
    },
    ...options,
  });
}

export async function getItemCatalog(
  typeMainId: number = 1,
  cred?: string,
  locale?: string,
  salt?: string,
  options: any = {},
): Promise<any | null> {
  const url = `https://zonai.skport.com/web/v1/wiki/item/catalog`;
  return makeRequest("GET", url, {
    cred,
    locale,
    salt,
    params: { typeMainId, gameId: 3 },
    headers: {
      Origin: "https://wiki.skport.com",
      Referer: "https://wiki.skport.com/",
    },
    ...options,
  });
}

export async function getItemInfo(
  id: number | string,
  cred?: string,
  locale?: string,
  salt?: string,
  options: any = {},
): Promise<any | null> {
  const url = `https://zonai.skport.com/web/v1/wiki/item/info`;
  return makeRequest("GET", url, {
    cred,
    locale,
    salt,
    params: { id },
    headers: {
      Origin: "https://wiki.skport.com",
      Referer: "https://wiki.skport.com/",
    },
    ...options,
  });
}

export async function loginByEmailPassword(
  credentials: { email: string; password?: string },
  captcha?: any,
) {
  const url = "https://as.gryphline.com/user/auth/v1/token_by_email_password";

  const data: any = {
    email: credentials.email,
    password: credentials.password,
  };

  if (captcha) {
    data.captcha = {
      geetest_challenge: captcha.geetest_challenge,
      geetest_validate: captcha.geetest_validate,
      geetest_seccode: captcha.geetest_seccode,
    };
  }

  // Use official Gryphline headers matching the geetest curl command
  try {
    const response = await axios.post(url, data, {
      headers: {
        accept: "application/json",
        "accept-language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6",
        "content-type": "application/json",
        origin: "https://www.skport.com",
        priority: "u=1, i",
        referer: "https://www.skport.com/",
        "sec-ch-ua":
          '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "x-language": "zh-tw",
      },
    });

    const aigisHeader = response.headers["x-rpc-aigis"];
    if (aigisHeader) {
      return {
        ...response.data,
        aigisHeader: aigisHeader,
      };
    }

    return response.data;
  } catch (error: any) {
    console.error(`Error requesting ${url}:`, error.message);
    return null;
  }
}
