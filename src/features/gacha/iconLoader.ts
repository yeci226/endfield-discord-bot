import { loadImage } from "@napi-rs/canvas";
import path from "path";
import fs from "fs";
import { fetchImage } from "../../utils/canvasUtils";
import { decodedImageCache } from "../../utils/byteLruCache";

const OFFICIAL_CHARACTER_ICON_URLS: Readonly<
  Record<string, string | undefined>
> = Object.freeze({
  chr_0004_pelica:
    "https://bbs.hycdn.cn/image/common/20260128/5246026/6979ace2deae33c4ae1159c0_3eac6ad0.png",
  chr_0005_chen:
    "https://bbs.hycdn.cn/image/common/20260129/4826366/697b015c4973d8a1133f7876_6ad0f152.png",
  chr_0006_wolfgd:
    "https://bbs.hycdn.cn/image/common/20260203/5246026/6981cf549fd9f8e1d8fd61cc_3eac6ad0.png",
  chr_0007_ikut:
    "https://bbs.hycdn.cn/image/common/20260203/101423/6981b85449da91d62c6689cc_f1525633.png",
  chr_0009_azrila:
    "https://bbs.hycdn.cn/image/common/20260217/2054140/69940065223662a892b01da4_db193eac.png",
  chr_0011_seraph:
    "https://bbs.hycdn.cn/image/common/20260217/2054140/6993df14b32aacba0e7256d4_13673ac9.png",
  chr_0012_avywen:
    "https://bbs.hycdn.cn/image/common/20260208/4826366/6987747b94e337a3813bf30c_13673ac9.png",
  chr_0013_aglina:
    "https://bbs.hycdn.cn/image/common/20260203/101423/6980d4aa4973d8a11340c613_2f76db19.png",
  chr_0014_aurora:
    "https://bbs.hycdn.cn/image/common/20260202/4826366/6980bf4a3a151ae9156138f7_f1525633.png",
  chr_0015_lifeng:
    "https://bbs.hycdn.cn/image/common/20260204/2274383/69822586645bf8ceddc4e329_f1525633.png",
  chr_0016_laevat:
    "https://bbs.hycdn.cn/image/2025/12/29/2054140/9a215e451767e4527e1f8d1f8ce09fef.png",
  chr_0017_yvonne:
    "https://bbs.hycdn.cn/image/common/20260202/4850358/69807e73d262875d5b986600_2f76db19.png",
  chr_0018_dapan:
    "https://bbs.hycdn.cn/image/common/20260208/4826366/698771821acbba54e4b0e048_3eac6ad0.png",
  chr_0019_karin:
    "https://bbs.hycdn.cn/image/2026/01/12/2641152/00598faf8a7eccab9c4d64e102faac6b.png",
  chr_0020_meurs:
    "https://bbs.hycdn.cn/image/common/20260202/5246026/6980af993a151ae9156136ea_f1525633.png",
  chr_0021_whiten:
    "https://bbs.hycdn.cn/image/common/20260204/2274383/6982b354f139cae54d7333a2_6ad0f152.png",
  chr_0022_bounda:
    "https://bbs.hycdn.cn/image/2026/01/12/2641152/d50a55c6f0bb70419677592a21b635ef.png",
  chr_0023_antal:
    "https://bbs.hycdn.cn/image/common/20260204/4850358/69835ef9645bf8ceddc50a96_2f76db19.png",
  chr_0024_deepfin:
    "https://bbs.hycdn.cn/image/common/20260217/4826366/699434292468ffc1c1e2b772_f1525633.png",
  chr_0025_ardelia:
    "https://bbs.hycdn.cn/image/2026/01/26/4826366/3f24dfab756936f20757e5a5b5ddd966.png",
  chr_0026_lastrite:
    "https://bbs.hycdn.cn/image/common/20260203/101423/6981a44d9fd9f8e1d8fd5d22_56331367.png",
  chr_0027_tangtang:
    "https://bbs.hycdn.cn/image/common/20260312/2274383/69b211574298be0edf042cea_f1525633.png",
  chr_0028_wulfa:
    "https://bbs.hycdn.cn/image/common/20260329/4826366/69c8998745f7d92a73c88faf_2f76db19.png",
  chr_0029_pograni:
    "https://bbs.hycdn.cn/image/common/20260204/2054140/6983540cf139cae54d734e26_13673ac9.png",
  chr_0030_zhuangfy:
    "https://bbs.hycdn.cn/image/common/20260417/2641152/69e12fbefe4a20e7c0d83e4e_f1525633.png",
  chr_0031_mifu:
    "https://bbs.hycdn.cn/image/common/20260605/4826366/6a22112497bfaba8393d24e0_56331367.png",
  chr_0032_lizhiyan:
    "https://bbs.hycdn.cn/image/common/20260714/4634516/6a55d3861da1e29cd294f0d1_6ad0f152.png",
  chr_0033_camille:
    "https://bbs.hycdn.cn/image/common/20260626/5246026/6a3dfcd1690f9d18da26a0cd_3eac6ad0.png",
  chr_0034_typhoea:
    "https://bbs.hycdn.cn/image/common/20260902/221109/6a9772282e39b624e0143815_3eac6ad0.png",
  chr_0035_liino:
    "https://bbs.hycdn.cn/image/common/20260809/4826366/6a77c4b6a87c0071fa15da57_3eac6ad0.png",
});

const OFFICIAL_WEAPON_ICON_URLS: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    wpn_claym_0003:
      "https://bbs.hycdn.cn/image/common/20260712/4634516/6a5273ed3fd5188add197c5f_56331367.png",
    wpn_claym_0004:
      "https://bbs.hycdn.cn/image/common/20260712/5246026/6a532691243287dc0488bab0_6ad0f152.png",
    wpn_claym_0006:
      "https://bbs.hycdn.cn/image/common/20260712/5246026/6a530f205a4a706f1ca0a1fd_3eac6ad0.png",
    wpn_claym_0008:
      "https://bbs.hycdn.cn/image/common/20260712/5246026/6a53038e278e43d09a4a988b_56331367.png",
    wpn_claym_0009:
      "https://bbs.hycdn.cn/image/common/20260712/4634516/6a5361dcc8001c330ab426f2_2f76db19.png",
    wpn_claym_0011:
      "https://bbs.hycdn.cn/image/common/20260716/3644013/6a58964f9555d0dbeb3be3d7_13673ac9.png",
    wpn_claym_0012:
      "https://bbs.hycdn.cn/image/common/20260713/4850358/6a54ca34a8fd4a2648a7803b_56331367.png",
    wpn_claym_0014:
      "https://bbs.hycdn.cn/image/common/20260713/4850358/6a54cf5368e6358adf7c4457_f1525633.png",
    wpn_claym_0015:
      "https://bbs.hycdn.cn/image/common/20260713/4850358/6a54d354504224056186ffe4_6ad0f152.png",
    wpn_funnel_0001:
      "https://bbs.hycdn.cn/image/common/20260712/4850358/6a537e3b5a4a706f1ca0a258_56331367.png",
    wpn_funnel_0003:
      "https://bbs.hycdn.cn/image/common/20260713/3644013/6a547ad09555d0dbeb3bddc1_f1525633.png",
    wpn_funnel_0004:
      "https://bbs.hycdn.cn/image/common/20260712/221109/6a533695625fc6185f8ab070_3eac6ad0.png",
    wpn_funnel_0005:
      "https://bbs.hycdn.cn/image/common/20260712/221109/6a532f56625fc6185f8ab06b_db193eac.png",
    wpn_funnel_0007:
      "https://bbs.hycdn.cn/image/common/20260712/221109/6a532bbd1e0a2272afdf9a1b_db193eac.png",
    wpn_funnel_0008:
      "https://bbs.hycdn.cn/image/common/20260705/3644013/6a4a5a0f758aae6784496fef_56331367.png",
    wpn_funnel_0009:
      "https://bbs.hycdn.cn/image/common/20260714/179550/6a5629ca68cdea4a26484d91_3eac6ad0.png",
    wpn_funnel_0012:
      "https://bbs.hycdn.cn/image/common/20260712/5246026/6a53705a5a4a706f1ca0a24d_2f76db19.png",
    wpn_funnel_0014:
      "https://bbs.hycdn.cn/image/common/20260712/5246026/6a536178860beb756f1b0ddc_2f76db19.png",
    wpn_funnel_0016:
      "https://bbs.hycdn.cn/image/common/20260716/221109/6a5828b068cdea4a26484f5d_f1525633.png",
    wpn_funnel_0019:
      "https://bbs.hycdn.cn/image/common/20260902/4826366/6a977074c40accef2ad54999_f1525633.png",
    wpn_lance_0003:
      "https://bbs.hycdn.cn/image/common/20260712/4634516/6a536692967194f4c24fd006_13673ac9.png",
    wpn_lance_0004:
      "https://bbs.hycdn.cn/image/common/20260716/3644013/6a588b2268e6358adf7c48c9_56331367.png",
    wpn_lance_0006:
      "https://bbs.hycdn.cn/image/common/20260712/2274383/6a5374c244ffd33c0c6651bc_6ad0f152.png",
    wpn_lance_0008:
      "https://bbs.hycdn.cn/image/common/20260712/4850358/6a5385014b9802b668e90b34_13673ac9.png",
    wpn_lance_0010:
      "https://bbs.hycdn.cn/image/common/20260706/3644013/6a4b552a17bac1f2c71ee605_3eac6ad0.png",
    wpn_lance_0011:
      "https://bbs.hycdn.cn/image/common/20260706/3644013/6a4b50551c1c7a6292e093e0_db193eac.png",
    wpn_lance_0013:
      "https://bbs.hycdn.cn/image/common/20260716/3644013/6a5888468e326c8c8730ae4e_3eac6ad0.png",
    wpn_lance_0014:
      "https://bbs.hycdn.cn/image/common/20260808/4634516/6a772fb96febdf01b964b1e2_f1525633.png",
    wpn_pistol_0002:
      "https://bbs.hycdn.cn/image/common/20260712/221109/6a53643cb58634b212e7c4ad_2f76db19.png",
    wpn_pistol_0003:
      "https://bbs.hycdn.cn/image/common/20260712/221109/6a53613f68cdea4a26484b7f_f1525633.png",
    wpn_pistol_0004:
      "https://bbs.hycdn.cn/image/common/20260712/3644013/6a5330d61e0a2272afdf9a20_db193eac.png",
    wpn_pistol_0006:
      "https://bbs.hycdn.cn/image/common/20260712/2274383/6a52fcf9504224056186fdf8_f1525633.png",
    wpn_pistol_0008:
      "https://bbs.hycdn.cn/image/common/20260706/3644013/6a4b4663278e43d09a4a92dc_56331367.png",
    wpn_pistol_0009:
      "https://bbs.hycdn.cn/image/common/20260706/3644013/6a4b179e860beb756f1b085c_2f76db19.png",
    wpn_pistol_0012:
      "https://bbs.hycdn.cn/image/common/20260712/3644013/6a5339718e326c8c8730a834_56331367.png",
    wpn_sword_0005:
      "https://bbs.hycdn.cn/image/common/20260712/5246026/6a53533f1e0a2272afdf9a2c_f1525633.png",
    wpn_sword_0007:
      "https://bbs.hycdn.cn/image/common/20260712/5246026/6a534fac9186cc76da288b05_2f76db19.png",
    wpn_sword_0008:
      "https://bbs.hycdn.cn/image/common/20260702/4634516/6a468abf504224056186f33f_3eac6ad0.png",
    wpn_sword_0009:
      "https://bbs.hycdn.cn/image/common/20260712/4634516/6a526cd05a4a706f1ca0a1c0_2f76db19.png",
    wpn_sword_0011:
      "https://bbs.hycdn.cn/image/common/20260716/736412/6a57bb979186cc76da288f40_6ad0f152.png",
    wpn_sword_0012:
      "https://bbs.hycdn.cn/image/common/20260708/736412/6a4d30567495486f8405dac4_db193eac.png",
    wpn_sword_0013:
      "https://bbs.hycdn.cn/image/common/20260708/736412/6a4d2800bf92cb409e3786b9_6ad0f152.png",
    wpn_sword_0015:
      "https://bbs.hycdn.cn/image/common/20260712/2641152/6a5394ff7495486f8405ddd0_56331367.png",
    wpn_sword_0018:
      "https://bbs.hycdn.cn/image/common/20260712/2641152/6a53a5bad7edf9a01564e5ee_3eac6ad0.png",
    wpn_sword_0019:
      "https://bbs.hycdn.cn/image/common/20260712/2641152/6a539c3536daa0d3b3b1f1c1_2f76db19.png",
    wpn_sword_0020:
      "https://bbs.hycdn.cn/image/common/20260712/2641152/6a53b4eba60e9ad15db7d71c_2f76db19.png",
  });

export function getGachaIconUrlCandidates(
  isCharacter: boolean,
  rawId: string,
): string[] {
  const cid = String(rawId || "").replace("icon_", "");
  if (!cid) return [];

  if (isCharacter) {
    const officialUrl = OFFICIAL_CHARACTER_ICON_URLS[cid];
    return [
      officialUrl,
      `https://endfieldtools.dev/assets/images/endfield/charicon/icon_${cid}.png`,
      `https://endfield.ooo.run/ake/operators/icon_${cid}.webp`,
    ].filter((url): url is string => Boolean(url));
  }

  const officialUrl = OFFICIAL_WEAPON_ICON_URLS[cid];
  return officialUrl ? [officialUrl] : [];
}

/** Names probed for one icon id, in priority order inside one directory. */
export function localIconCandidateNames(
  isCharacter: boolean,
  cid: string,
): string[] {
  return isCharacter
    ? [`icon_${cid}.png`, `icon_${cid}.webp`, `icon_${cid}.jpg`]
    : [
        `${cid}.png`,
        `${cid}.webp`,
        `${cid}.jpg`,
        `icon_${cid}.png`,
        `icon_${cid}.webp`,
        `icon_${cid}.jpg`,
      ];
}

export interface IconDirIndex {
  dir: string;
  files: Set<string>;
}

/** Every existing local file for the candidates, directory-major, name-minor (the old probing order). */
export function pickLocalIconPaths(
  index: IconDirIndex[],
  names: string[],
): string[] {
  const out: string[] = [];
  for (const { dir, files } of index) {
    for (const name of names) {
      if (files.has(name)) out.push(path.join(dir, name));
    }
  }
  return out;
}

export function buildIconIndex(
  dirs: string[],
  readdir: (dir: string) => string[] = (d) => fs.readdirSync(d),
): IconDirIndex[] {
  return dirs.map((dir) => {
    let names: string[] = [];
    try {
      names = readdir(dir);
    } catch {}
    return { dir, files: new Set(names) };
  });
}

export const ICON_INDEX_REFRESH_MS = 10 * 60_000;
const LOCAL_ICON_DIRS = [
  path.join(__dirname, "../../assets/remote_cache"),
  path.join(__dirname, "../../assets/cache"),
];
let iconIndex: { builtAt: number; index: IconDirIndex[] } | null = null;

/** Directory listing built once and refreshed at most every 10 minutes. */
export function getLocalIconIndex(
  now: number = Date.now(),
  dirs: string[] = LOCAL_ICON_DIRS,
): IconDirIndex[] {
  if (!iconIndex || now - iconIndex.builtAt >= ICON_INDEX_REFRESH_MS) {
    iconIndex = { builtAt: now, index: buildIconIndex(dirs) };
  }
  return iconIndex.index;
}

export function resetLocalIconIndex(): void {
  iconIndex = null;
}

/** Longest a card render waits for one remote image before drawing without it. */
export const GACHA_IMAGE_TIMEOUT_MS = 8000;
const FAILED_IMAGE_TTL_MS = 60_000;
const FAILED_IMAGE_MAX = 500;
const failedImageUrls = new Map<string, number>();

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number = GACHA_IMAGE_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Remote image for a draw path: 8 s ceiling, and a URL that just failed is not
 * retried for a minute (so one dead host cannot add 8 s to every card).
 * Callers draw a placeholder when this throws.
 */
export async function fetchImageTimed(
  url: string,
  cacheName?: string,
  now: number = Date.now(),
): Promise<any> {
  const failedAt = failedImageUrls.get(url);
  if (failedAt !== undefined && now - failedAt < FAILED_IMAGE_TTL_MS) {
    throw new Error(`recently failed: ${url}`);
  }
  try {
    return await withTimeout(
      fetchImage(url, cacheName, { timeoutMs: GACHA_IMAGE_TIMEOUT_MS }),
      GACHA_IMAGE_TIMEOUT_MS,
    );
  } catch (e) {
    if (failedImageUrls.size >= FAILED_IMAGE_MAX) {
      const oldest = failedImageUrls.keys().next();
      if (!oldest.done) failedImageUrls.delete(oldest.value);
    }
    failedImageUrls.delete(url);
    failedImageUrls.set(url, now);
    throw e;
  }
}

export function resetFailedImageUrls(): void {
  failedImageUrls.clear();
}

const inFlightIcons = new Map<string, Promise<any>>();

export const loadGachaIconImage = async (
  isCharacter: boolean,
  rawId: string,
): Promise<any> => {
  const cid = String(rawId || "").replace("icon_", "");
  if (!cid) throw new Error("Missing icon id");

  const cacheKey = `gacha-icon:${isCharacter ? "c" : "w"}:${cid}`;
  const cached = decodedImageCache.get(cacheKey);
  if (cached) return cached;
  const pending = inFlightIcons.get(cacheKey);
  if (pending) return pending;

  const job = resolveGachaIcon(isCharacter, rawId, cid).then((img) => {
    decodedImageCache.set(cacheKey, img);
    return img;
  });
  inFlightIcons.set(cacheKey, job);
  try {
    return await job;
  } finally {
    inFlightIcons.delete(cacheKey);
  }
};

async function resolveGachaIcon(
  isCharacter: boolean,
  rawId: string,
  cid: string,
): Promise<any> {
  for (const localPath of pickLocalIconPaths(
    getLocalIconIndex(),
    localIconCandidateNames(isCharacter, cid),
  )) {
    try {
      return await loadImage(await fs.promises.readFile(localPath));
    } catch {}
  }

  const cacheName = isCharacter ? `icon_${cid}` : cid;
  let lastError: unknown;
  for (const iconUrl of getGachaIconUrlCandidates(isCharacter, rawId)) {
    try {
      return await fetchImageTimed(iconUrl, cacheName);
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError ?? new Error(`Failed to resolve icon for ${cid}`);
}
