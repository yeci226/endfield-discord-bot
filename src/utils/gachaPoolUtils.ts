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
