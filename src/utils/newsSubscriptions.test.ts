import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase } from "./Database";
import {
  DISPATCH_RETENTION_MS,
  DispatchRecord,
  FeedItem,
  NEWS_MIGRATION_MARKER,
  NewsSub,
  addGuildNewsChannel,
  bindDmNews,
  dispatchActionFor,
  dispatchKey,
  failedDispatchRecord,
  listGuildNewsSubs,
  listNewsSubs,
  migrateNewsSubscriptions,
  newsSubKey,
  nextSubscriptionState,
  removeGuildNews,
  selectItemsToDispatch,
  setGuildNewsChannels,
  shouldBaselineSkip,
  shouldPruneDispatch,
  sweepNewsDispatch,
  unbindDmNews,
} from "./newsSubscriptions";

let counter = 0;
async function withDb(fn: (db: CustomDatabase) => Promise<void>) {
  const file = path.join(
    os.tmpdir(),
    "ef-news-test-" + process.pid + "-" + counter++ + ".sqlite",
  );
  const db = new CustomDatabase(file);
  try {
    await fn(db);
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"])
      fs.rmSync(file + suffix, { force: true });
  }
}

const sub = (over: Partial<NewsSub> = {}): NewsSub => ({
  guildId: "g1",
  channelId: "c1",
  failCount: 0,
  addedAt: 1000,
  ...over,
});
const item = (id: string, timestampMs: number, hash = "h"): FeedItem => ({
  id,
  timestampMs,
  hash,
});

async function main() {
  // ---- nextSubscriptionState
  {
    const s = sub();
    assert.deepEqual(nextSubscriptionState(s, null), { sub: s, remove: false });
    const failing = sub({ failCount: 2 });
    assert.deepEqual(nextSubscriptionState(failing, null), {
      sub: { ...failing, failCount: 0 },
      remove: false,
    });
    // transient errors never count against the subscription
    for (const code of [undefined, 500, 429, 50035, 40005]) {
      const r = nextSubscriptionState(s, code as any);
      if (code === undefined) continue; // undefined == success
      assert.equal(r.remove, false);
      assert.equal(r.sub.failCount, 0);
    }
    // permanent errors: removed at the third strike
    let cur = s;
    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const r = nextSubscriptionState(cur, 10003);
      seen.push(r.remove);
      cur = r.sub;
    }
    assert.deepEqual(seen, [false, false, true]);
    for (const code of [10003, 10004, 10007, 50001, 50007, 50013])
      assert.equal(nextSubscriptionState(sub({ failCount: 2 }), code).remove, true);
    // a success in between resets the count
    const recovered = nextSubscriptionState(nextSubscriptionState(s, 50013).sub, null);
    assert.equal(recovered.sub.failCount, 0);
  }

  // ---- dispatchActionFor
  {
    const it = item("1", 5000, "new");
    const base = { sub: { addedAt: 1000 }, item: it, historyChanged: false };
    assert.equal(dispatchActionFor({ ...base, record: null }), "send");
    assert.equal(
      dispatchActionFor({ ...base, sub: { addedAt: 9000 }, record: null }),
      null,
      "items older than the subscription are skipped",
    );
    assert.equal(
      dispatchActionFor({ ...base, sub: { addedAt: 9000 }, record: null, force: true }),
      "send",
    );
    // failed attempts are retried up to 5 times
    for (let attempts = 1; attempts <= 4; attempts++)
      assert.equal(
        dispatchActionFor({ ...base, record: { delivered: false, attempts } }),
        "send",
      );
    assert.equal(
      dispatchActionFor({ ...base, record: { delivered: false, attempts: 5 } }),
      null,
    );
    // delivered rows: edit only when the hash changed
    const delivered: DispatchRecord = { messageId: "m", hash: "new", createdAt: 1 };
    assert.equal(dispatchActionFor({ ...base, record: delivered }), null);
    assert.equal(
      dispatchActionFor({ ...base, record: { ...delivered, hash: "old" } }),
      "edit",
    );
    // legacy row (no createdAt): untouched unless the feed history says it changed
    const legacy: DispatchRecord = { messageId: "m", hash: "old" };
    assert.equal(dispatchActionFor({ ...base, record: legacy }), null);
    assert.equal(
      dispatchActionFor({ ...base, historyChanged: true, record: legacy }),
      "edit",
    );
    assert.equal(
      dispatchActionFor({ ...base, record: { hash: "old", createdAt: 1 } }),
      null,
      "nothing to edit without a message id",
    );
  }

  // ---- selectItemsToDispatch
  {
    const subs = [sub({ channelId: "a" }), sub({ channelId: "b" })];
    const items = [1, 2, 3, 4, 5].map((n) => item(String(n), 2000 + n * 100));
    const records = new Map<string, DispatchRecord>();
    const getRecord = (i: FeedItem, s: NewsSub) => records.get(dispatchKey(i.id, s)) ?? null;

    // regression: a legacy row (exactly what the old code wrote) settles the item
    for (const n of ["1", "2", "3"])
      for (const s of subs)
        records.set(dispatchKey(n, s), {
          newsId: n,
          channelId: s.channelId,
          messageId: "m" + n,
          hash: "h",
        });
    assert.equal(dispatchKey("1", subs[0]), "news_dispatch.1.a", "legacy key shape is preserved");
    let picked = selectItemsToDispatch({ items, subs, getRecord });
    assert.deepEqual(picked.map((p) => p.item.id), ["4", "5"], "oldest undelivered first, not just the newest three");
    assert.equal(picked[0].work.length, 2);
    // only the legacy-delivered items -> nothing
    assert.deepEqual(selectItemsToDispatch({ items: items.slice(0, 3), subs, getRecord }), []);

    // more than three undelivered: all are taken, capped at 10
    const many = Array.from({ length: 14 }, (_, i) => item("n" + i, 5000 + i));
    picked = selectItemsToDispatch({ items: many, subs: [sub()], getRecord });
    assert.equal(picked.length, 10);
    assert.equal(picked[0].item.id, "n0");
    assert.equal(picked[9].item.id, "n9");
    assert.equal(selectItemsToDispatch({ items: many, subs: [sub()], getRecord, max: 2 }).length, 2);

    // subscription added after the item: not eligible; failed-but-retriable stays pending
    const late = sub({ channelId: "late", addedAt: 99_999 });
    assert.deepEqual(selectItemsToDispatch({ items: many, subs: [late], getRecord }), []);
    records.set(dispatchKey("4", subs[0]), { delivered: false, attempts: 2 });
    records.set(dispatchKey("4", subs[1]), { delivered: true, messageId: "x", hash: "h" });
    records.set(dispatchKey("5", subs[0]), { messageId: "x", hash: "h" });
    records.set(dispatchKey("5", subs[1]), { messageId: "x", hash: "h" });
    picked = selectItemsToDispatch({ items, subs, getRecord });
    assert.deepEqual(picked.map((p) => p.item.id), ["4"]);
    assert.equal(picked[0].work.length, 1);
    assert.equal(picked[0].work[0].sub.channelId, "a");
  }

  // ---- failedDispatchRecord / baseline / prune rules
  {
    const r1 = failedDispatchRecord(null, { newsId: "1", hash: "h" }, 50);
    assert.deepEqual(r1, { newsId: "1", hash: "h", createdAt: 50, delivered: false, attempts: 1 });
    assert.equal(failedDispatchRecord(r1, { newsId: "1", hash: "h" }, 99).attempts, 2);
    assert.equal(failedDispatchRecord(r1, { newsId: "1", hash: "h" }, 99).createdAt, 50);

    const day = 24 * 3600 * 1000;
    const now = 100 * day;
    assert.equal(shouldBaselineSkip({ item: item("1", now - 3 * day), hasHistory: false, firstPoll: true, now }), true);
    assert.equal(shouldBaselineSkip({ item: item("1", now - 3 * day), hasHistory: true, firstPoll: true, now }), false);
    assert.equal(shouldBaselineSkip({ item: item("1", now - 3 * day), hasHistory: false, firstPoll: false, now }), false);
    assert.equal(shouldBaselineSkip({ item: item("1", now - 3600_000), hasHistory: false, firstPoll: true, now }), false);

    const feed = new Set(["10"]);
    const row = (id: string, createdAt: unknown, newsId: unknown, feedIds: Set<string> | null = feed) =>
      shouldPruneDispatch({ id, createdAt, newsId, now, feedIds });
    assert.equal(row("news_dispatch.1.c", now - DISPATCH_RETENTION_MS - 1, "1"), true);
    assert.equal(row("news_dispatch.1.c", now - DISPATCH_RETENTION_MS + 1000, "1"), false);
    assert.equal(row("news_dispatch.10.c", now - DISPATCH_RETENTION_MS - 1, "10"), true, "createdAt wins over feed membership");
    assert.equal(row("news_dispatch.1.c", undefined, "1"), true, "legacy row, item left the feed");
    assert.equal(row("news_dispatch.10.c", undefined, "10"), false, "legacy row, item still in the feed");
    assert.equal(row("news_dispatch.1.c", undefined, "1", null), false, "feed unknown: never delete legacy rows");
    assert.equal(row("news_dispatch.10.c", undefined, undefined), false, "item id parsed from the key");
    assert.equal(row("news_dispatch.7.c", null, undefined), true);
  }

  // ---- migration
  await withDb(async (db) => {
    await db.set("news_subscriptions", [
      { guildId: "g1", channelId: "c1", boundAt: 111 },
      { guildId: "g1", channelId: "c2", boundAt: 222 },
      { guildId: "DM", channelId: "dm9", boundAt: 333 },
      { guildId: "g2", channelId: "c3" },
      { nonsense: true },
      null,
    ]);
    const r = await migrateNewsSubscriptions(db, 5000);
    assert.deepEqual(r, { migrated: 4, skipped: false });
    const subs = await listNewsSubs(db);
    assert.equal(subs.length, 4);
    assert.deepEqual(await db.get(newsSubKey("g1", "c1")), {
      guildId: "g1",
      channelId: "c1",
      failCount: 0,
      addedAt: 111,
    });
    assert.equal((await db.get<NewsSub>(newsSubKey("g2", "c3")))!.addedAt, 5000);
    const dm = (await db.get<NewsSub>(newsSubKey("DM", "dm9")))!;
    assert.equal(dm.guildId, "DM");
    assert.equal(dm.addedAt, 5000, "a migrated DM subscription starts at the migration time, not the old boundAt");
    // the old code never delivered to DMs: ten older items must not arrive as a backlog
    const feed = Array.from({ length: 10 }, (_, i) => ({ id: String(i), timestampMs: 1000 + i * 100, hash: "h" }));
    assert.deepEqual(selectItemsToDispatch({ items: feed, subs: [dm], getRecord: () => null }), []);
    const fresh = { id: "new", timestampMs: 5001, hash: "h" };
    const picked = selectItemsToDispatch({ items: [...feed, fresh], subs: [dm], getRecord: () => null });
    assert.deepEqual(picked.map((p) => [p.item.id, p.work.length]), [["new", 1]]);
    assert.equal((await db.get<any[]>("news_subscriptions"))!.length, 6, "legacy array is kept");
    assert.ok(await db.get(NEWS_MIGRATION_MARKER));

    // a removed subscription is not revived by a later run (marker), and the run is idempotent
    removeGuildNews(db, "g1");
    assert.deepEqual(await migrateNewsSubscriptions(db, 6000), { migrated: 0, skipped: true });
    assert.deepEqual(await listGuildNewsSubs(db, "g1"), []);
    assert.equal((await listNewsSubs(db)).length, 2);
  });

  await withDb(async (db) => {
    // existing rows win; no marker => a re-run only adds what is missing
    await db.set("news_subscriptions", [{ guildId: "g1", channelId: "c1", boundAt: 1 }]);
    await db.set(newsSubKey("g1", "c1"), { guildId: "g1", channelId: "c1", failCount: 2, addedAt: 77 });
    const r = await migrateNewsSubscriptions(db, 9);
    assert.equal(r.migrated, 0);
    assert.equal((await db.get<NewsSub>(newsSubKey("g1", "c1")))!.failCount, 2);
    // no legacy array at all
    await withDb(async (db2) => {
      assert.deepEqual(await migrateNewsSubscriptions(db2, 1), { migrated: 0, skipped: false });
    });
  });

  // ---- row API used by /news and the interaction handlers
  await withDb(async (db) => {
    setGuildNewsChannels(db, "g1", ["a", "b"], 100);
    setGuildNewsChannels(db, "g2", ["z"], 100);
    assert.equal((await listGuildNewsSubs(db, "g1")).length, 2);
    // rebinding keeps addedAt of channels that stay, drops the others
    setGuildNewsChannels(db, "g1", ["b", "c"], 500);
    const g1 = await listGuildNewsSubs(db, "g1");
    assert.deepEqual(g1.map((s) => [s.channelId, s.addedAt]).sort(), [["b", 100], ["c", 500]]);
    assert.equal(addGuildNewsChannel(db, "g1", "c", 900), false);
    assert.equal(addGuildNewsChannel(db, "g1", "d", 900), true);
    // guild ids that share a prefix must not collide
    setGuildNewsChannels(db, "g10", ["q"], 1);
    assert.equal(removeGuildNews(db, "g1"), 3);
    assert.equal((await listGuildNewsSubs(db, "g10")).length, 1);
    assert.equal((await listGuildNewsSubs(db, "g2")).length, 1);
    setGuildNewsChannels(db, "g2", [], 1);
    assert.equal((await listGuildNewsSubs(db, "g2")).length, 0, "empty selection unbinds all");

    assert.equal(bindDmNews(db, "u1", "dmch", 5), true);
    assert.equal(bindDmNews(db, "u1", "dmch", 6), false);
    assert.equal((await db.get<NewsSub>(newsSubKey("DM", "u1")))!.userId, "u1");
    await db.set(newsSubKey("DM", "legacydm"), { guildId: "DM", channelId: "legacydm", failCount: 0, addedAt: 1 });
    assert.equal(bindDmNews(db, "u2", "legacydm"), false, "migrated legacy row counts as bound");
    assert.equal(unbindDmNews(db, "u1", "dmch"), 1);
    assert.equal(unbindDmNews(db, "u2", "legacydm"), 1);
    assert.equal(unbindDmNews(db, "u2", "legacydm"), 0);
  });

  // ---- retention sweep is bounded, resumable, and respects both row shapes
  await withDb(async (db) => {
    const day = 24 * 3600 * 1000;
    const now = 200 * day;
    for (let i = 0; i < 50; i++) {
      // legacy rows for items long gone from the feed
      await db.set(`news_dispatch.old${String(i).padStart(3, "0")}.c`, {
        newsId: "old" + i,
        channelId: "c",
        messageId: "m",
        hash: "h",
      });
    }
    await db.set("news_dispatch.live.c", { newsId: "live", channelId: "c" }); // legacy, item in feed
    await db.set("news_dispatch.new1.c", { newsId: "new1", createdAt: now - 10 * day });
    await db.set("news_dispatch.new2.c", { newsId: "new2", createdAt: now - 100 * day });
    await db.set("news_other.keep", { x: 1 });
    const feedIds = new Set(["live", "new1"]);

    let yields = 0;
    let cursor: string | null = null;
    let totalDeleted = 0;
    let rounds = 0;
    do {
      const r: { deleted: number; cursor: string | null; scanned: number } = await sweepNewsDispatch(db, {
        now,
        feedIds,
        cursor,
        pageSize: 10,
        maxScan: 25,
        maxDelete: 12,
        yieldFn: async () => void yields++,
      });
      assert.ok(r.deleted <= 12, "never deletes more than maxDelete per run");
      totalDeleted += r.deleted;
      cursor = r.cursor;
      rounds++;
      assert.ok(rounds < 20, "terminates");
    } while (cursor !== null);
    assert.ok(yields > 0, "yields between pages");
    assert.equal(totalDeleted, 51, "50 legacy + 1 expired");
    assert.deepEqual(
      (await db.findIdsByPrefix("news_dispatch.")).sort(),
      ["news_dispatch.live.c", "news_dispatch.new1.c"],
    );
    assert.ok(await db.get("news_other.keep"));

    // feed unknown: legacy rows survive, createdAt rows are still pruned
    await db.set("news_dispatch.gone.c", { newsId: "gone" });
    await db.set("news_dispatch.exp.c", { newsId: "exp", createdAt: now - 91 * day });
    const r = await sweepNewsDispatch(db, { now, feedIds: null });
    assert.equal(r.deleted, 1);
    assert.equal(r.cursor, null);
    assert.ok(await db.get("news_dispatch.gone.c"));
  });

  console.log("newsSubscriptions tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
