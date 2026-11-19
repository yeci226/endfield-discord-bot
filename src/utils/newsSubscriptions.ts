import type { CustomDatabase } from "./Database";

export const NEWS_SUB_PREFIX = "news_sub.";
export const NEWS_DISPATCH_PREFIX = "news_dispatch.";
export const NEWS_MIGRATION_MARKER = "migration.news_sub.v1";

/** Discord errors that will not fix themselves: channel/guild gone, user blocked DMs, no access. */
export const PERMANENT_SEND_CODES: ReadonlySet<number> = new Set([
  10003, 10004, 10007, 50001, 50007, 50013,
]);
export const MAX_SUB_FAILS = 3;
export const MAX_ITEM_ATTEMPTS = 5;
export const MAX_ITEMS_PER_POLL = 10;
export const DISPATCH_RETENTION_MS = 90 * 24 * 3600 * 1000;

export interface NewsSub {
  /** Guild id, or "DM" for a private subscription. */
  guildId: string;
  channelId: string;
  /** Set for DM subscriptions created after the row-per-subscription change. */
  userId?: string;
  lang?: string;
  failCount: number;
  addedAt: number;
}

export interface DispatchRecord {
  newsId?: string;
  channelId?: string;
  guildId?: string;
  messageId?: string;
  hash?: string;
  /** Absent on rows written before this change. */
  createdAt?: number;
  /** false = a send was attempted and failed (attempts tells how often). Absent/true = delivered. */
  delivered?: boolean;
  attempts?: number;
}

export interface FeedItem {
  id: string;
  timestampMs: number;
  hash: string;
}

export type DispatchAction = "send" | "edit";

// ---------------------------------------------------------------- keys

/** `news_sub.<guildId|DM>.<channelId|userId>` */
export const newsSubKey = (guildId: string, targetId: string) =>
  `${NEWS_SUB_PREFIX}${guildId}.${targetId}`;

export const subKeyOf = (sub: NewsSub) =>
  newsSubKey(
    sub.guildId,
    sub.guildId === "DM" ? (sub.userId ?? sub.channelId) : sub.channelId,
  );

/**
 * Per-subscription suffix of `news_dispatch.<itemId>.<suffix>`. Guild
 * subscriptions keep the bare channel id, exactly what the old code wrote, so
 * deliveries recorded before the migration still count.
 */
export const dispatchSuffix = (sub: NewsSub) =>
  sub.guildId === "DM" ? `DM.${sub.userId ?? sub.channelId}` : sub.channelId;

export const dispatchKey = (itemId: string, sub: NewsSub) =>
  `${NEWS_DISPATCH_PREFIX}${itemId}.${dispatchSuffix(sub)}`;

// ------------------------------------------------------- pure decisions

export function isPermanentSendError(code: unknown): boolean {
  return PERMANENT_SEND_CODES.has(Number(code));
}

/**
 * New state of a subscription after one delivery outcome. `errorCode` null =
 * success. Permanent Discord errors count towards removal; anything else
 * leaves the subscription alone (the item is retried on the next poll).
 */
export function nextSubscriptionState(
  sub: NewsSub,
  errorCode: number | null | undefined,
): { sub: NewsSub; remove: boolean } {
  if (errorCode === null || errorCode === undefined)
    return {
      sub: sub.failCount ? { ...sub, failCount: 0 } : sub,
      remove: false,
    };
  if (!isPermanentSendError(errorCode)) return { sub, remove: false };
  const failCount = (sub.failCount || 0) + 1;
  return { sub: { ...sub, failCount }, remove: failCount >= MAX_SUB_FAILS };
}

/** What one subscription still needs for one feed item, or null when settled. */
export function dispatchActionFor(args: {
  sub: Pick<NewsSub, "addedAt">;
  item: FeedItem;
  record: DispatchRecord | null;
  /** The feed item's content changed since the last poll that saw it. */
  historyChanged: boolean;
  force?: boolean;
}): DispatchAction | null {
  const { sub, item, record } = args;
  if (args.force) return "send";
  if (!record) return item.timestampMs < (sub.addedAt || 0) ? null : "send";
  if (record.delivered === false)
    return (record.attempts || 0) >= MAX_ITEM_ATTEMPTS ? null : "send";
  // Delivered. Edit only when the content changed and we know the message.
  // Rows written before this change carry no createdAt; for those the feed
  // history is the only trustworthy "changed" signal.
  if (
    record.messageId &&
    record.hash !== item.hash &&
    (record.createdAt != null || args.historyChanged)
  )
    return "edit";
  return null;
}

export interface ItemWork {
  item: FeedItem;
  work: Array<{
    sub: NewsSub;
    action: DispatchAction;
    record: DispatchRecord | null;
  }>;
}

/**
 * Items that still have undelivered work, oldest first, starting at the oldest
 * item with pending work and capped at `max` (default 10).
 */
export function selectItemsToDispatch(args: {
  items: FeedItem[];
  subs: NewsSub[];
  getRecord: (item: FeedItem, sub: NewsSub) => DispatchRecord | null;
  historyChanged?: (item: FeedItem) => boolean;
  force?: boolean;
  max?: number;
}): ItemWork[] {
  const max = args.max ?? MAX_ITEMS_PER_POLL;
  const ordered = [...args.items].sort((a, b) => a.timestampMs - b.timestampMs);
  const out: ItemWork[] = [];
  for (const item of ordered) {
    const changed = args.historyChanged?.(item) ?? false;
    const work: ItemWork["work"] = [];
    for (const sub of args.subs) {
      const record = args.getRecord(item, sub);
      const action = dispatchActionFor({
        sub,
        item,
        record,
        historyChanged: changed,
        force: args.force,
      });
      if (action) work.push({ sub, action, record });
    }
    if (work.length) out.push({ item, work });
    if (out.length >= max) break;
  }
  return out;
}

/** Row to store after a failed non-permanent send (so the retry budget survives restarts). */
export function failedDispatchRecord(
  prev: DispatchRecord | null,
  base: Pick<DispatchRecord, "newsId" | "channelId" | "guildId" | "hash">,
  now: number,
): DispatchRecord {
  return {
    ...base,
    createdAt: prev?.createdAt ?? now,
    delivered: false,
    attempts: (prev?.attempts || 0) + 1,
  };
}

/**
 * First poll after the migration: an item without history that is old was
 * never processed by the old code (it only looked at the newest three).
 * Sending it now would re-post old news to every channel.
 */
export function shouldBaselineSkip(args: {
  item: FeedItem;
  hasHistory: boolean;
  firstPoll: boolean;
  now: number;
  graceMs?: number;
}): boolean {
  if (!args.firstPoll || args.hasHistory) return false;
  return args.now - args.item.timestampMs > (args.graceMs ?? 24 * 3600 * 1000);
}

/** Retention rule for `news_dispatch.*` rows. `feedIds` null = the feed is unknown (fetch failed/empty). */
export function shouldPruneDispatch(args: {
  id: string;
  createdAt: unknown;
  newsId: unknown;
  now: number;
  feedIds: ReadonlySet<string> | null;
}): boolean {
  if (typeof args.createdAt === "number")
    return args.now - args.createdAt > DISPATCH_RETENTION_MS;
  if (!args.feedIds) return false;
  const itemId =
    args.newsId != null && args.newsId !== ""
      ? String(args.newsId)
      : args.id.slice(NEWS_DISPATCH_PREFIX.length).split(".")[0];
  return !args.feedIds.has(itemId);
}

// ------------------------------------------------------------ storage

export async function listNewsSubs(db: CustomDatabase): Promise<NewsSub[]> {
  const rows = await db.findByPrefix<NewsSub>(NEWS_SUB_PREFIX);
  return rows.map((r) => r.value).filter((v) => v && v.channelId && v.guildId);
}

export async function listGuildNewsSubs(
  db: CustomDatabase,
  guildId: string,
): Promise<NewsSub[]> {
  const rows = await db.findByPrefix<NewsSub>(`${NEWS_SUB_PREFIX}${guildId}.`);
  return rows.map((r) => r.value);
}

/** Replace a guild's bound channels. Channels that stay bound keep their original addedAt. */
export function setGuildNewsChannels(
  db: CustomDatabase,
  guildId: string,
  channelIds: string[],
  now = Date.now(),
): void {
  db.transaction((store) => {
    const prefix = `${NEWS_SUB_PREFIX}${guildId}.`;
    const wanted = new Set(channelIds);
    for (const key of store.keys(prefix)) {
      if (!wanted.has(key.slice(prefix.length))) store.delete(key);
    }
    for (const channelId of wanted) {
      const key = newsSubKey(guildId, channelId);
      const prev = store.get<NewsSub>(key);
      store.set(key, {
        guildId,
        channelId,
        lang: prev?.lang,
        failCount: 0,
        addedAt: prev?.addedAt ?? now,
      } as NewsSub);
    }
  });
}

/** Adds one channel; returns false when it was already bound. */
export function addGuildNewsChannel(
  db: CustomDatabase,
  guildId: string,
  channelId: string,
  now = Date.now(),
): boolean {
  return db.transaction((store) => {
    const key = newsSubKey(guildId, channelId);
    if (store.get(key)) return false;
    store.set(key, {
      guildId,
      channelId,
      failCount: 0,
      addedAt: now,
    } as NewsSub);
    return true;
  });
}

export function removeGuildNews(db: CustomDatabase, guildId: string): number {
  return db.deleteByPrefix(`${NEWS_SUB_PREFIX}${guildId}.`);
}

export function bindDmNews(
  db: CustomDatabase,
  userId: string,
  channelId: string,
  now = Date.now(),
): boolean {
  return db.transaction((store) => {
    const key = newsSubKey("DM", userId);
    // A migrated legacy row for the same DM channel counts as already bound.
    if (store.get(key) || store.get(newsSubKey("DM", channelId))) return false;
    store.set(key, {
      guildId: "DM",
      channelId,
      userId,
      failCount: 0,
      addedAt: now,
    } as NewsSub);
    return true;
  });
}

export function unbindDmNews(
  db: CustomDatabase,
  userId: string,
  channelId: string,
): number {
  return db.transaction((store) => {
    let n = 0;
    for (const key of [newsSubKey("DM", userId), newsSubKey("DM", channelId)]) {
      if (store.get(key)) {
        store.delete(key);
        n++;
      }
    }
    return n;
  });
}

/**
 * Copies the legacy `news_subscriptions` array into one row per subscription.
 * Idempotent and non-destructive: existing rows are kept, the array stays, and
 * a marker stops later runs so a subscription the user removed is not revived.
 */
export async function migrateNewsSubscriptions(
  db: CustomDatabase,
  now = Date.now(),
): Promise<{ migrated: number; skipped: boolean }> {
  if (await db.get(NEWS_MIGRATION_MARKER))
    return { migrated: 0, skipped: true };
  const legacy = (await db.get<any[]>("news_subscriptions")) || [];
  const migrated = db.transaction((store) => {
    let n = 0;
    for (const entry of Array.isArray(legacy) ? legacy : []) {
      if (
        !entry ||
        typeof entry.guildId !== "string" ||
        typeof entry.channelId !== "string"
      )
        continue;
      const key = newsSubKey(entry.guildId, entry.channelId);
      if (store.get(key)) continue;
      store.set(key, {
        guildId: entry.guildId,
        channelId: entry.channelId,
        failCount: 0,
        // DM entries were never delivered by the old code: start them now so the
        // first poll does not send a backlog. Guild entries keep their bind time.
        addedAt: entry.guildId === "DM" ? now : Number(entry.boundAt) || now,
      } as NewsSub);
      n++;
    }
    store.set(NEWS_MIGRATION_MARKER, { at: now, migrated: n });
    return n;
  });
  return { migrated, skipped: false };
}

/**
 * One bounded retention pass over `news_dispatch.*`: scans up to `maxScan`
 * rows from `cursor` and deletes at most `maxDelete` of them (one transaction
 * per page), yielding to the event loop between pages. Returns the cursor to
 * continue from (null = reached the end, start over next time).
 */
export async function sweepNewsDispatch(
  db: CustomDatabase,
  opts: {
    now?: number;
    feedIds: ReadonlySet<string> | null;
    cursor?: string | null;
    pageSize?: number;
    maxScan?: number;
    maxDelete?: number;
    yieldFn?: () => Promise<void>;
  },
): Promise<{ scanned: number; deleted: number; cursor: string | null }> {
  const now = opts.now ?? Date.now();
  const pageSize = opts.pageSize ?? 2000;
  const maxScan = opts.maxScan ?? 20_000;
  const maxDelete = opts.maxDelete ?? 2000;
  const yieldFn =
    opts.yieldFn ?? (() => new Promise<void>((r) => setImmediate(r)));
  let cursor = opts.cursor ?? null;
  let scanned = 0;
  let deleted = 0;
  while (scanned < maxScan && deleted < maxDelete) {
    const page = db.scanFieldsByPrefix(
      NEWS_DISPATCH_PREFIX,
      ["$.createdAt", "$.newsId"],
      cursor,
      pageSize,
    );
    if (!page.length) return { scanned, deleted, cursor: null };
    scanned += page.length;
    const doomed: string[] = [];
    let lastScanned = cursor;
    let stoppedEarly = false;
    for (const row of page) {
      if (doomed.length >= maxDelete - deleted) {
        stoppedEarly = true;
        break;
      }
      lastScanned = row.id;
      if (
        shouldPruneDispatch({
          id: row.id,
          createdAt: row.fields[0],
          newsId: row.fields[1],
          now,
          feedIds: opts.feedIds,
        })
      )
        doomed.push(row.id);
    }
    deleted += db.deleteIds(doomed);
    cursor = lastScanned;
    if (!stoppedEarly && page.length < pageSize)
      return { scanned, deleted, cursor: null };
    await yieldFn();
  }
  return { scanned, deleted, cursor };
}
