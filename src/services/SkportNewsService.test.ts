import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { CustomDatabase } from "../utils/Database";
import { newsSubKey } from "../utils/newsSubscriptions";
import { StartupHooks } from "../utils/startup";
import { SkportNewsService, deliverNewsOnCluster, newsItemHash } from "./SkportNewsService";

const HOUR = 3600 * 1000;
let counter = 0;

function newsItem(id: string, ageMs: number, now: number, title = "T" + id) {
  return {
    item: {
      id,
      title,
      resourceLocale: "zh_Hant",
      caption: [{ kind: "text", text: { text: "body " + id } }],
      shareLink: "x",
      timestamp: String(Math.floor((now - ageMs) / 1000)),
    },
    user: { nickname: "Official", avatar: "" },
  } as any;
}

/** A fake cluster that owns the given channels and records what was sent. */
function fakeCluster(
  guilds: string[],
  channels: Record<string, { fail?: number }>,
  log: string[],
) {
  return {
    guilds: { cache: new Set(guilds) },
    channels: {
      cache: {
        get: (id: string) => {
          const spec = channels[id];
          if (!spec) return undefined;
          return {
            send: async (p: any) => {
              if (spec.fail) throw Object.assign(new Error("fail"), { code: spec.fail });
              log.push("send:" + id);
              return { id: "msg-" + id + "-" + log.length };
            },
            messages: {
              fetch: async () => ({
                edit: async () => void log.push("edit:" + id),
              }),
            },
          };
        },
      },
    },
  };
}

async function withService(
  setup: (db: CustomDatabase) => Promise<void>,
  run: (ctx: {
    svc: any;
    db: CustomDatabase;
    sentLog: string[];
    dmLog: string[];
    broadcasts: { count: number };
    channels: Record<string, { fail?: number }>;
  }) => Promise<void>,
) {
  const file = path.join(os.tmpdir(), "ef-newssvc-" + process.pid + "-" + counter++ + ".sqlite");
  const db = new CustomDatabase(file);
  try {
    await setup(db);
    const sentLog: string[] = [];
    const dmLog: string[] = [];
    const broadcasts = { count: 0 };
    const channels: Record<string, { fail?: number }> = {
      c1: {},
      c2: {},
      bad: { fail: 10003 },
      flaky: { fail: 500 },
    };
    const cluster = fakeCluster(["g1", "g2"], channels, sentLog);
    const client: any = {
      db,
      cluster: {
        id: 0,
        broadcastEval: async (fn: any, opts: any) => {
          broadcasts.count++;
          // exactly what a remote cluster does: run the stringified function in a bare context
          const remote = vm.runInNewContext("(" + fn.toString() + ")", { Promise });
          return [JSON.parse(JSON.stringify(await remote(cluster, opts.context)))];
        },
      },
      users: {
        send: async (userId: string) => {
          dmLog.push("user:" + userId);
          return { id: "dm-" + userId };
        },
      },
      channels: {
        fetch: async (id: string) => ({
          send: async () => {
            dmLog.push("channel:" + id);
            return { id: "dmc-" + id };
          },
        }),
      },
    };
    await run({ svc: new SkportNewsService(client), db, sentLog, dmLog, broadcasts, channels });
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  }
}

const sub = (guildId: string, channelId: string, addedAt: number, extra: object = {}) => ({
  guildId,
  channelId,
  failCount: 0,
  addedAt,
  ...extra,
});

async function main() {
  const now = Date.now();

  // deliverNewsOnCluster is self-contained and only answers for guilds it owns
  {
    const log: string[] = [];
    const cluster = fakeCluster(["g1"], { c1: {}, bad: { fail: 50013 } }, log);
    const remote = vm.runInNewContext("(" + deliverNewsOnCluster.toString() + ")", { Promise });
    const results = await remote(cluster, {
      payload: {},
      work: [
        { suffix: "c1", guildId: "g1", channelId: "c1", action: "send" },
        { suffix: "other", guildId: "gX", channelId: "c9", action: "send" },
        { suffix: "gone", guildId: "g1", channelId: "nope", action: "send" },
        { suffix: "bad", guildId: "g1", channelId: "bad", action: "send" },
        { suffix: "c1e", guildId: "g1", channelId: "c1", action: "edit", messageId: "m1" },
      ],
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(results)).map((r: any) => [r.suffix, r.ok, r.code ?? null]),
      [
        ["c1", true, null],
        ["gone", false, 10003],
        ["bad", false, 50013],
        ["c1e", true, null],
      ],
    );
    assert.deepEqual(log, ["send:c1", "edit:c1"]);
  }

  // deploy day: legacy rows settle items 1-3; only the genuinely new item is posted; old unseen items are baselined
  await withService(
    async (db) => {
      await db.set(newsSubKey("g1", "c1"), sub("g1", "c1", now - 100 * 24 * HOUR));
      for (const id of ["1", "2", "3"]) {
        await db.set(`news_dispatch.${id}.c1`, { newsId: id, channelId: "c1", messageId: "m" + id, hash: "legacy" });
        // the old code kept the history hash current; only the dispatch row's own hash could lag behind
        await db.set(`news_history.${id}`, { id, title: "t", hash: newsItemHash(newsItem(id, 0, now)), timestamp: 1 });
      }
    },
    async ({ svc, db, sentLog, broadcasts }) => {
      const items = [
        newsItem("5", 20 * 24 * HOUR, now), // old, never seen by the old code
        newsItem("6", 10 * 24 * HOUR, now), // old, never seen
        newsItem("1", 3 * 24 * HOUR, now),
        newsItem("2", 2 * 24 * HOUR, now),
        newsItem("3", 1 * 24 * HOUR - HOUR, now),
        newsItem("4", HOUR, now), // new
      ];
      await svc.processFeed(items, false);
      assert.deepEqual(sentLog, ["send:c1"], "only item 4 is posted; no re-post of legacy or old items");
      assert.equal(broadcasts.count, 1);
      const row = await db.get<any>("news_dispatch.4.c1");
      assert.equal(row.delivered, true);
      assert.ok(row.createdAt);
      assert.ok(row.messageId);
      assert.equal((await db.get<any>("news_history.5")).complete, true);
      assert.equal((await db.get<any>("news_history.4")).complete, true);
      // a second poll has nothing to do and does not even broadcast
      await svc.processFeed(items, false);
      assert.equal(broadcasts.count, 1);
      assert.deepEqual(sentLog, ["send:c1"]);
    },
  );

  // more than three new items in one poll are all delivered, oldest first
  await withService(
    async (db) => {
      await db.set("news.baseline.v1", { at: 1 });
      await db.set(newsSubKey("g1", "c1"), sub("g1", "c1", now - 100 * HOUR));
    },
    async ({ svc, sentLog }) => {
      const items = ["a", "b", "c", "d", "e"].map((id, i) => newsItem(id, (10 - i) * HOUR, now));
      await svc.processFeed(items, false);
      assert.equal(sentLog.length, 5);
    },
  );

  // failures: transient errors retry up to 5 times; permanent errors remove the subscription at the third
  await withService(
    async (db) => {
      await db.set("news.baseline.v1", { at: 1 });
      await db.set(newsSubKey("g1", "flaky"), sub("g1", "flaky", now - 50 * HOUR));
      await db.set(newsSubKey("g1", "bad"), sub("g1", "bad", now - 50 * HOUR));
      await db.set(newsSubKey("g2", "c2"), sub("g2", "c2", now - 50 * HOUR));
    },
    async ({ svc, db, sentLog, broadcasts }) => {
      const items = [newsItem("9", HOUR, now)];
      await svc.processFeed(items, false);
      assert.deepEqual(sentLog, ["send:c2"], "healthy channels are not held back by failing ones");
      const flaky = await db.get<any>("news_dispatch.9.flaky");
      assert.deepEqual([flaky.delivered, flaky.attempts], [false, 1]);
      assert.equal((await db.get<any>(newsSubKey("g1", "bad"))).failCount, 1);
      assert.equal((await db.get<any>("news_history.9")).complete, false, "failed item stays open");
      await svc.processFeed(items, false);
      assert.equal((await db.get<any>("news_dispatch.9.flaky")).attempts, 2);
      assert.equal((await db.get<any>(newsSubKey("g1", "bad"))).failCount, 2);
      await svc.processFeed(items, false);
      assert.equal(await db.get(newsSubKey("g1", "bad")), null, "removed after three permanent failures");
      assert.ok(await db.get(newsSubKey("g1", "flaky")), "transient failures never remove the subscription");
      await svc.processFeed(items, false);
      await svc.processFeed(items, false);
      assert.equal((await db.get<any>("news_dispatch.9.flaky")).attempts, 5);
      const before = broadcasts.count;
      await svc.processFeed(items, false);
      assert.equal(broadcasts.count, before, "gave up after 5 attempts: nothing left to do");
      assert.equal(sentLog.filter((l) => l === "send:c2").length, 1, "c2 got it exactly once");
    },
  );

  // DM subscriptions are really delivered (by user id, or by channel for migrated legacy rows)
  await withService(
    async (db) => {
      await db.set("news.baseline.v1", { at: 1 });
      await db.set(newsSubKey("DM", "u1"), sub("DM", "dmch1", now - 50 * HOUR, { userId: "u1" }));
      await db.set(newsSubKey("DM", "legacydm"), sub("DM", "legacydm", now - 50 * HOUR));
    },
    async ({ svc, db, dmLog, broadcasts }) => {
      await svc.processFeed([newsItem("7", HOUR, now)], false);
      assert.deepEqual(dmLog.sort(), ["channel:legacydm", "user:u1"]);
      assert.equal((await db.get<any>("news_dispatch.7.DM.u1")).delivered, true);
      assert.equal((await db.get<any>("news_dispatch.7.DM.legacydm")).delivered, true);
      assert.equal(broadcasts.count, 0, "DMs never go through the cluster broadcast");
    },
  );

  // an updated item edits the already delivered message instead of re-posting
  await withService(
    async (db) => {
      await db.set("news.baseline.v1", { at: 1 });
      await db.set(newsSubKey("g1", "c1"), sub("g1", "c1", now - 50 * HOUR));
    },
    async ({ svc, sentLog }) => {
      await svc.processFeed([newsItem("8", HOUR, now, "first")], false);
      await svc.processFeed([newsItem("8", HOUR, now, "edited title")], false);
      assert.deepEqual(sentLog, ["send:c1", "edit:c1"]);
    },
  );

  // startup: the legacy array is migrated BEFORE the first poll starts, and only the primary cluster does anything
  await withService(
    async (db) => {
      await db.set("news_subscriptions", [{ guildId: "g1", channelId: "c1", boundAt: 1 }]);
    },
    async ({ db }) => {
      const hooks = new StartupHooks({ info: () => {}, error: (m, e) => console.error(m, e) });
      const svc: any = new SkportNewsService({ db, startup: hooks } as any);
      const seen: string[][] = [];
      svc.start = () => void seen.push(db.findKeysByPrefix("news_sub."));
      svc.register();
      await hooks.run(true);
      assert.deepEqual(seen, [["news_sub.g1.c1"]], "first poll already sees the migrated rows");
      hooks.stop();

      const other = new StartupHooks({ info: () => {}, error: () => {} });
      const svc2: any = new SkportNewsService({ db, startup: other } as any);
      let started = 0;
      svc2.start = () => void started++;
      svc2.register();
      await other.run(false);
      assert.equal(started, 0, "secondary clusters never poll");
    },
  );

  console.log("SkportNewsService tests passed");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
