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

export interface CardDailyMission {
  dailyActivation: number;
  maxDailyActivation: number;
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
  bpSystem: CardBpSystem;
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
 * Helper to construct the sk-game-role header value
 */
export function formatSkGameRole(
  gameId: number,
  roleId: string,
  serverId: string,
): string {
  // For Endfield, the format is usually "Platform_UserID_Server"
  // where Platform is '3' for PC/Android.
  return `3_${roleId}_${serverId}`;
}

// Core Helper
function getCommonHeaders(cred: string | undefined, locale?: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6",
    "sec-ch-ua":
      '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    cred: cred,
    platform: "3",
    vName: "1.0.0",
    "sk-language": formatSkLanguage(locale),
    timestamp: timestamp,
    Origin: "https://game.skport.com",
    Referer: "https://game.skport.com/",
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
): Promise<string | null> {
  const url = "https://zonai.skport.com/web/v1/auth/refresh";
  const headers = {
    platform,
    vName: "1.0.0",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    cred: cred,
    Origin: "https://game.skport.com",
    Referer: "https://game.skport.com/",
  };

  try {
    const response = await axios.get(url, { headers });
    const json = response.data;
    if (json && json.code === 0 && json.data?.token) {
      return json.data.token;
    }
  } catch (error: any) {
    logger.error(`[Skport] refreshSkToken failed: ${error.message}`);
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
        Origin: "https://www.skport.com",
        Referer: "https://www.skport.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
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
    const newSalt = await refreshSkToken(currentCred, platform);
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

    // Clean up undefined headers
    Object.keys(headers).forEach((key) => {
      if (headers[key] === undefined) delete headers[key];
    });

    if (method === "POST" && options.data !== undefined) {
      headers["Content-Type"] = "application/json";
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

    // Use V2 (HMAC) for binding and critical endpoints
    const useV2 =
      pathname.includes("/binding") ||
      pathname.includes("/card/detail") ||
      pathname.includes("/wiki/") ||
      pathname.includes("/enums") ||
      pathname.includes("/attendance") ||
      pathname.includes("/v2/");

    const signContent = method === "POST" ? bodyString : queryString;
    const dId = headers.dId || headers.did || "";

    // Ensure dId is in headers if we are using it for signature
    if (!headers.dId && !headers.did) {
      headers.dId = dId;
    }

    const sign = useV2
      ? generateSignV2(
          pathname,
          signContent,
          headers.timestamp,
          headers.platform,
          headers.vName || headers.vname || "1.0.0",
          dId,
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
          logger.warn(`[401 Unauthorized] URL: ${url}`);
          // Return an object that mirrors the structure expected by the stale check
          return { code: 10000, status: 401, ...(resp?.data || {}) };
        } else {
          logger.error(`Error requesting ${url}: ${error.message}`);
        }
      }
      return resp?.data || null;
    }
  };

  let result: any = await execute();

  // Automatic retry on stale token (code 10000 or 401 status)
  const isStale = result && (result.code === 10000 || result.status === 401);
  if (isStale && options.onStale) {
    logger.info(
      `Stale token (Code ${result.code}, HTTP ${result.status}) detected. Attempting refresh...`,
    );
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
async function grantOAuthCode(
  token: string,
  appCode: string = "6eb76d4e13aa36e6",
  type: number = 0,
) {
  const url = "https://as.gryphline.com/user/oauth2/v2/grant";
  return makeRequest<any>("POST", url, {
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
async function generateCredByCode(code: string) {
  const url = "https://zonai.skport.com/web/v1/user/auth/generate_cred_by_code";
  return makeRequest<any>("POST", url, {
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
}

export async function verifyToken(cookie: string, locale?: string) {
  // 1. Extract raw token value regardless of input format (raw value or full cookie)
  let cleanToken = cookie.trim();

  // If it's a cookie string, extract ACCOUNT_TOKEN
  const match = cleanToken.match(/ACCOUNT_TOKEN=([^;\s]+)/);
  if (match) {
    cleanToken = match[1];
  } else if (cleanToken.includes("=")) {
    // If it has '=' but no ACCOUNT_TOKEN, it might be an invalid cookie or another key
    // We try to find any value that looks like a token if ACCOUNT_TOKEN is missing
    const parts = cleanToken.split(";")[0].split("=");
    if (parts.length > 1) cleanToken = parts[1];
  }

  // Ensure we have a decoded version if it was already encoded
  try {
    const decoded = decodeURIComponent(cleanToken);
    // Only use decoded if it's different (to handle potential double encoding issues)
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
    return basicResult; // Error or null
  }

  // 2. Grant OAuth Code
  const grantResult = await grantOAuthCode(cleanToken);
  if (grantResult && grantResult.status === 0 && grantResult.data?.code) {
    const code = grantResult.data.code;

    // 3. Generate Skport Cred
    const credResult = await generateCredByCode(code);
    if (credResult && credResult.code === 0 && credResult.data?.cred) {
      return {
        ...basicResult,
        cred: credResult.data.cred, // Attach the user-specific cred
        token: credResult.data.token, // Attach the salt/token
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
  const url = "https://zonai.skport.com/api/v1/game/player/binding";
  const headers: any = {
    Referer: "https://game.skport.com/",
    Origin: "https://game.skport.com",
    vname: "1.0.0",
    platform: "3",
    "Content-Type": "application/json",
  };
  if (cookie) headers.Cookie = cookie;

  const res = await makeRequest<{
    code: number;
    data: { list: GameBinding[] };
  }>("GET", url, {
    locale,
    cred,
    salt,
    headers,
    ...options,
  });
  if (res && res.code === 0) {
    return res.data.list;
  }
  return null;
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
  gameRole: string,
  cookie: string | undefined,
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<{ code: number; data: AttendanceResponse } | null> {
  const url = "https://zonai.skport.com/web/v1/game/endfield/attendance";
  const headers: any = {
    "sk-game-role": gameRole,
    Referer: "https://game.skport.com/",
  };
  if (cookie) headers.Cookie = cookie;

  const res = await makeRequest<{ code: number; data: AttendanceResponse }>(
    "GET",
    url,
    {
      locale,
      cred,
      salt,
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
  gameRole: string,
  cookie: string | undefined,
  locale?: string,
  cred?: string,
  salt?: string,
  options: any = {},
): Promise<{ code: number; message: string; data?: AttendanceResponse }> {
  const url = "https://zonai.skport.com/web/v1/game/endfield/attendance";
  const headers: any = {
    "sk-game-role": gameRole,
    Referer: "https://game.skport.com/",
  };
  if (cookie) headers.Cookie = cookie;

  const res = await makeRequest<{
    code: number;
    message: string;
    data?: AttendanceResponse;
  }>("POST", url, {
    locale,
    cred,
    salt,
    headers,
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
  console.log(`[Debug] loginByEmailPassword using URL: ${url}`);

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

  // Use a simpler request for Gryphline to avoid 403 from excess headers
  try {
    const response = await axios.post(url, data, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
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
