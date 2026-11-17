import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomDatabase } from "./Database";
import {
  deleteReminderWizardSession,
  getReminderWizardSession,
  pruneExpiredReminderWizardSessions,
  saveReminderWizardSession,
} from "./reminderWizardSessions";

interface TestSession {
  owner: string;
  expires: number;
  page: string;
}

async function main() {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "endfield-reminder-wizard-test-"),
  );
  const dbPath = path.join(tempDir, "json.sqlite");
  let workerA: CustomDatabase | undefined;
  let workerB: CustomDatabase | undefined;
  const session: TestSession = {
    owner: "user-1",
    expires: Date.now() + 60_000,
    page: "home",
  };

  try {
    workerA = new CustomDatabase(dbPath);
    workerB = new CustomDatabase(dbPath);
    await saveReminderWizardSession(workerA, "token-1", session);
    assert.deepEqual(
      await getReminderWizardSession<TestSession>(workerB, "token-1"),
      session,
      "a different cluster worker must be able to load a live wizard session",
    );

    await saveReminderWizardSession(workerA, "expired-token", {
      ...session,
      expires: Date.now() - 1,
    });
    assert.equal(
      await getReminderWizardSession<TestSession>(workerB, "expired-token"),
      undefined,
      "expired sessions must not be restored",
    );
    assert.equal(
      await workerA.get("reminderWizard.session.v1.expired-token"),
      null,
      "expired sessions must be removed from persistent storage",
    );

    await saveReminderWizardSession(workerA, "expired-a", {
      ...session,
      expires: Date.now() - 1,
    });
    await saveReminderWizardSession(workerA, "live-b", session);
    await pruneExpiredReminderWizardSessions(workerB, Date.now());
    assert.equal(await workerA.get("reminderWizard.session.v1.expired-a"), null);
    assert.deepEqual(await workerA.get("reminderWizard.session.v1.live-b"), session);
    await deleteReminderWizardSession(workerB, "live-b");
    assert.equal(await workerA.get("reminderWizard.session.v1.live-b"), null);
  } finally {
    (workerA as any)?.db.close();
    (workerB as any)?.db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log("reminderWizardSessions checks passed");
}

void main();
