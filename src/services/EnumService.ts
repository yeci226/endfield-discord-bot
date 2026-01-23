import { getEnums, SkEnumsData } from "../utils/skportApi";
import { CustomDatabase } from "../utils/Database";

export class EnumService {
  private static readonly CACHE_KEY = "game_enums_cache";
  private static readonly REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  public static async getEnumsCached(
    db: CustomDatabase,
    cred?: string,
    locale?: string,
  ): Promise<SkEnumsData | null> {
    const cached = await db.get<{ data: SkEnumsData; timestamp: number }>(
      this.CACHE_KEY,
    );
    const now = Date.now();

    if (cached && now - cached.timestamp < this.REFRESH_INTERVAL) {
      return cached.data;
    }

    // Refresh cache
    try {
      const res = await getEnums(cred, locale);
      if (res && res.code === 0 && res.data) {
        await db.set(this.CACHE_KEY, {
          data: res.data,
          timestamp: now,
        });
        return res.data;
      }
    } catch (error) {
      console.error("[EnumService] Failed to refresh enums:", error);
    }

    // Fallback to stale cache if API fails
    return cached?.data || null;
  }
}
