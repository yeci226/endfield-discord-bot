import type { CustomDatabase } from "./Database";

export const AUTO_DAILY_PREFIX = "autoDaily.";

/**
 * Points every auto-daily row whose notification channel is one of
 * `guildChannelIds` at `targetChannelId`. Candidates are found with one
 * json_extract scan (no JSON is parsed in JS for rows that are not moved) and
 * each row is rewritten with an atomic `db.update`, re-checking the channel
 * inside the transaction so a concurrent change by the user is not overwritten
 * and nothing else in the row is touched. Returns the number of rows moved.
 */
export function moveDailyNotifyChannels(
  db: CustomDatabase,
  guildChannelIds: ReadonlySet<string>,
  targetChannelId: string,
): number {
  let moved = 0;
  for (const { id, field } of db.findFieldByPrefix(AUTO_DAILY_PREFIX, "$.channelId")) {
    if (!field || field === targetChannelId || !guildChannelIds.has(String(field))) continue;
    db.update<any>(id, (cur) => {
      if (
        !cur ||
        !cur.channelId ||
        cur.channelId === targetChannelId ||
        !guildChannelIds.has(String(cur.channelId))
      )
        return cur;
      moved++;
      return { ...cur, channelId: targetChannelId };
    });
  }
  return moved;
}
