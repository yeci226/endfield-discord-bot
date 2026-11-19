import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase, prefixUpperBound } from "./Database";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let counter = 0;

async function withDb(fn: (db: CustomDatabase) => Promise<void>) {
  const file = path.join(
    os.tmpdir(),
    "ef-db-test-" + process.pid + "-" + counter++ + ".sqlite",
  );
  const db = new CustomDatabase(file);
  try {
    await fn(db);
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(file + suffix, { force: true });
      } catch {}
    }
  }
}

async function main() {
  await withDb(async (db) => {
    // ttl
    db.setWithTtl("t.a", { x: 1 }, 60_000);
    assert.deepEqual(db.getFresh("t.a"), { x: 1 });
    db.setWithTtl("t.b", 1, -1);
    assert.equal(db.getFresh("t.b"), null);
    assert.equal(await db.get("t.b"), null); // expired row was deleted
    await db.set("t.c", { plain: true });
    assert.equal(db.getFresh("t.c"), null);
    assert.deepEqual(await db.get("t.c"), { plain: true }); // foreign shape untouched
  });

  await withDb(async (db) => {
    // deleteByPrefix is literal
    await db.set("a_1", 1);
    await db.set("a_2", 2);
    await db.set("ab1", 3);
    await db.set("a%x", 4);
    assert.equal(db.deleteByPrefix("a_"), 2);
    assert.equal(await db.get("ab1"), 3);
    assert.equal(await db.get("a%x"), 4);
    assert.throws(() => db.deleteByPrefix(""));
  });

  await withDb(async (db) => {
    // update
    assert.equal(db.update<number>("u.n", (c) => (c ?? 0) + 1), 1);
    assert.equal(db.update<number>("u.n", (c) => (c ?? 0) + 1), 2);
    assert.throws(
      () =>
        db.update("u.n", () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(await db.get("u.n"), 2); // nothing written
    assert.equal(db.update("u.n", () => null), null);
    assert.equal(await db.get("u.n"), null); // null deletes
    assert.throws(
      () => db.update("u.n", (() => Promise.resolve(1)) as any),
      /synchronous/,
    );
  });

  await withDb(async (db) => {
    // withKeyLock: same key serialises, rejection does not block, other keys are independent
    const order: string[] = [];
    const slow = db.withKeyLock("k", async () => {
      await sleep(40);
      order.push("a");
      throw new Error("x");
    });
    const next = db.withKeyLock("k", async () => {
      order.push("b");
      return 7;
    });
    const other = db.withKeyLock("other", async () => {
      order.push("c");
    });
    await assert.rejects(slow, /x/);
    assert.equal(await next, 7);
    await other;
    assert.deepEqual(order, ["c", "a", "b"]);
  });

  await withDb(async (db) => {
    // prefix queries use an ID range: literal, case-sensitive, unicode-safe
    for (const id of [
      "a_1",
      "a_2",
      "axb",
      "a%1",
      "A_9",
      "a_\u{1F600}x",
      "a_￿",
      "a_中",
      "b_1",
      "中文.1",
      "中文.2",
      "中文\u{1F600}",
    ]) {
      await db.set(id, { id });
    }
    const ids = async (p: string) => (await db.findIdsByPrefix(p)).sort();
    assert.deepEqual(
      await ids("a_"),
      ["a_1", "a_2", "a_中", "a_￿", "a_\u{1F600}x"].sort(),
    );
    assert.deepEqual(await ids("a%"), ["a%1"]);
    assert.deepEqual(await ids("A_"), ["A_9"]);
    assert.deepEqual(await ids("zzz"), []);
    assert.deepEqual(await ids("中文"), [
      "中文.1",
      "中文.2",
      "中文\u{1F600}",
    ]);
    assert.deepEqual(await ids("a_\u{1F600}"), ["a_\u{1F600}x"]);
    assert.equal((await ids("")).length, 12); // empty prefix = everything
    assert.deepEqual(db.findKeysByPrefix("b_"), ["b_1"]);
    assert.deepEqual(
      (await db.findByPrefix<{ id: string }>("a%")).map((r) => r.value.id),
      ["a%1"],
    );
    assert.deepEqual(db.findFieldByPrefix("b_", "$.id"), [
      { id: "b_1", field: "b_1" },
    ]);
    db.transaction((store) => {
      assert.deepEqual(store.keys("a_\u{1F600}"), ["a_\u{1F600}x"]);
      assert.equal(store.keys("a_").length, 5);
    });
    assert.equal(db.deleteByPrefix("a_"), 5);
    assert.deepEqual(await ids("a_"), []);
    assert.equal(db.deleteByPrefix("中文"), 3);
  });

  await withDb(async (db) => {
    // upper bound edge cases
    assert.equal(prefixUpperBound(""), null);
    assert.equal(prefixUpperBound("ab"), "ac");
    assert.equal(prefixUpperBound("a\u{10FFFF}"), "b");
    assert.equal(prefixUpperBound("\u{10FFFF}"), null);
    assert.equal(prefixUpperBound("퟿"), "");

    // scanFieldsByPrefix pages through a prefix in id order; deleteIds is exact
    for (let i = 0; i < 7; i++)
      await db.set(`s.${String(i).padStart(2, "0")}`, { n: i, c: i % 2 });
    await db.set("t.00", { n: 99 });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = db.scanFieldsByPrefix("s.", ["$.n", "$.missing"], cursor, 3);
      if (!page.length) break;
      assert.equal(page[0].fields[1], null);
      seen.push(...page.map((r) => r.id));
      cursor = page[page.length - 1].id;
    }
    assert.deepEqual(
      seen,
      [0, 1, 2, 3, 4, 5, 6].map((i) => `s.0${i}`),
    );
    assert.equal(
      db.scanFieldsByPrefix("s.", ["$.n"], "s.03", 2)[0].fields[0],
      4,
    );
    assert.equal(db.deleteIds(["s.00", "s.01", "nope", "t.00"]), 3);
    assert.equal(db.deleteIds([]), 0);
    assert.deepEqual(db.findKeysByPrefix("s."), [
      "s.02",
      "s.03",
      "s.04",
      "s.05",
      "s.06",
    ]);
  });

  console.log("Database tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
