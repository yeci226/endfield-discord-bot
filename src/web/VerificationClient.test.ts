import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase } from "../utils/Database";
import { VerificationClient } from "./VerificationClient";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const file = path.join(os.tmpdir(), `ef-verif-${process.pid}.sqlite`);
  const db = new CustomDatabase(file);
  try {
    // unknown session is refused, nothing is stored
    assert.equal(VerificationClient.submitResult("nope", { a: 1 }, db), false);
    assert.equal(db.getFresh("captcha_result:nope"), null);

    // result arrives late (from "another process" = a plain db write) -> resolves
    {
      const sid = VerificationClient.createSession("u1", db);
      const waiting = VerificationClient.waitForResult(sid, 2000, db, 20);
      setTimeout(
        () => assert.equal(VerificationClient.submitResult(sid, { ok: 1 }, db), true),
        100,
      );
      assert.deepEqual(await waiting, { ok: 1 });
      // row removed after read, session closed -> replay refused
      assert.equal(db.getFresh(`captcha_result:${sid}`), null);
      assert.equal(db.getFresh(`captcha_session:${sid}`), null);
      assert.equal(VerificationClient.submitResult(sid, { ok: 2 }, db), false);
    }

    // result already there before the wait starts
    {
      const sid = VerificationClient.createSession(undefined, db);
      VerificationClient.submitResult(sid, { early: true }, db);
      assert.deepEqual(await VerificationClient.waitForResult(sid, 500, db, 20), {
        early: true,
      });
    }

    // never arrives -> rejects, session cleaned up
    {
      const sid = VerificationClient.createSession("u2", db);
      const t0 = Date.now();
      await assert.rejects(
        VerificationClient.waitForResult(sid, 150, db, 20),
        /timed out/,
      );
      assert.ok(Date.now() - t0 < 1000);
      assert.equal(db.getFresh(`captcha_session:${sid}`), null);
      assert.equal(VerificationClient.submitResult(sid, {}, db), false);
    }

    // first result wins
    {
      const sid = VerificationClient.createSession("u3", db);
      assert.equal(VerificationClient.submitResult(sid, { n: 1 }, db), true);
      assert.equal(VerificationClient.submitResult(sid, { n: 2 }, db), false);
      assert.deepEqual(await VerificationClient.waitForResult(sid, 500, db, 20), {
        n: 1,
      });
    }

    // session ids are unguessable / unique
    const ids = new Set(
      Array.from({ length: 50 }, () => VerificationClient.createSession("x", db)),
    );
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{24}$/);

    // no live timers left: the process must be able to exit (the test itself ending proves it)
    await sleep(10);
  } finally {
    db.close();
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(file + s, { force: true });
  }
  console.log("VerificationClient tests passed");
}
main();
