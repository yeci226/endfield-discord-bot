import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase } from "./Database";

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

  console.log("Database tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
