export type GachaPoolCategory =
  "limited_char" | "rerun_char" | "standard_char" | "beginner_char" | "weapon";

export interface GachaPoolLike {
  type?: string;
  [key: string]: any;
}

export function getGachaPityGroupId(pool: GachaPoolLike): string {
  const type = pool.poolType || pool.type || "";
  const poolId = pool.poolId || pool.id || "";
  const poolName = pool.poolName || pool.name || "";

  if (type.includes("Rerun") || poolId.startsWith("rerun_chr_"))
    return "RerunShared";
  if (type.includes("Joint") || poolId.startsWith("joint_")) {
    return poolId || "Unknown";
  }
  if (type.includes("Special") || poolId.startsWith("c_special")) {
    return "SpecialShared";
  }
  if (type.includes("Beginner") || poolId.startsWith("c_beginner")) {
    return "Beginner";
  }
  if (
    type.includes("Standard") ||
    type.includes("Classic") ||
    poolId.startsWith("c_standard") ||
    poolName.includes("常駐")
  ) {
    return `Standard_${poolId}`;
  }
  if (poolName.includes("特選") || poolName.includes("限定")) {
    return "SpecialShared";
  }
  if (poolName.includes("新手")) return "Beginner";
  if (type.includes("Weapon") || poolId.startsWith("w_")) return poolId;

  return poolId || "Unknown";
}

export function isGachaPoolInCategory(
  pool: GachaPoolLike,
  category: GachaPoolCategory,
): boolean {
  const type = pool.type || "";
  if (category === "rerun_char") return type.includes("Rerun");
  if (category === "weapon") return type.includes("Weapon");
  if (category === "standard_char") {
    return type.includes("Standard") || type.includes("Classic");
  }
  if (category === "beginner_char") return type.includes("Beginner");
  return type.includes("Special") || type.includes("Joint");
}

export function paginateGachaOverviewPools<T extends GachaPoolLike>(
  pools: T[],
  category: GachaPoolCategory,
  requestedPage: number,
  perPage = 3,
): { pools: T[]; page: number; totalPages: number } {
  const filteredPools = pools.filter((pool) =>
    isGachaPoolInCategory(pool, category),
  );
  const totalPages = Math.max(1, Math.ceil(filteredPools.length / perPage));
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const start = page * perPage;

  return {
    pools: filteredPools.slice(start, start + perPage),
    page,
    totalPages,
  };
}

// ---- Pool select paging -------------------------------------------------
// A Discord select holds 25 options: the "overview" entry plus at most 24 more.
// With more pools than that the select pages: the newest 23 first (one slot left
// for "older"), 22 per middle page (two paging slots), the rest on the last page.

/** Value prefix of the "older / newer" options inside the pool select. */
export const POOL_PAGE_VALUE_PREFIX = "__pp:";

export function poolPageValue(page: number): string {
  return `${POOL_PAGE_VALUE_PREFIX}${page}`;
}

/** The page a paging option value asks for, or null for any other value. */
export function parsePoolPageValue(value: string | undefined | null): number | null {
  if (!value || !value.startsWith(POOL_PAGE_VALUE_PREFIX)) return null;
  const rest = value.slice(POOL_PAGE_VALUE_PREFIX.length);
  if (!/^\d{1,4}$/.test(rest)) return null;
  return Number(rest);
}

function poolPageBounds(count: number): Array<[number, number]> {
  if (count <= 24) return [[0, count]];
  const bounds: Array<[number, number]> = [[0, 23]];
  let start = 23;
  while (count - start > 23) {
    bounds.push([start, start + 22]);
    start += 22;
  }
  bounds.push([start, count]);
  return bounds;
}

export interface PoolOptionPage<T> {
  items: T[];
  /** Clamped page index. */
  page: number;
  totalPages: number;
  /** A page of older pools exists (page + 1). */
  hasOlder: boolean;
  /** A page of newer pools exists (page - 1). */
  hasNewer: boolean;
}

/** `pools` newest first. */
export function pagePoolOptions<T>(
  pools: T[],
  requestedPage: number,
): PoolOptionPage<T> {
  const bounds = poolPageBounds(pools.length);
  const page = Math.max(0, Math.min(Math.trunc(requestedPage) || 0, bounds.length - 1));
  const [from, to] = bounds[page];
  return {
    items: pools.slice(from, to),
    page,
    totalPages: bounds.length,
    hasOlder: page < bounds.length - 1,
    hasNewer: page > 0,
  };
}

/** The select page that contains this pool (0 when it is not in the list). */
export function findPoolPage<T extends { id: string }>(
  pools: T[],
  poolId: string,
): number {
  const index = pools.findIndex((p) => p.id === poolId);
  if (index < 0) return 0;
  const bounds = poolPageBounds(pools.length);
  const page = bounds.findIndex(([from, to]) => index >= from && index < to);
  return page < 0 ? 0 : page;
}
