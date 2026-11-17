import assert from "node:assert/strict";
import { AutoDailyService } from "./AutoDailyService";

const accountUtils = require("../utils/accountUtils");
const originals = {
  getAccounts: accountUtils.getAccounts,
  ensureAccountBinding: accountUtils.ensureAccountBinding,
};

async function main() {
  let accountCount = 1;
  accountUtils.getAccounts = async () =>
    Array.from({ length: accountCount }, (_, i) => ({
      invalid: true,
      info: { id: String(i), nickname: `Expired account ${i + 1}` },
    }));
  accountUtils.ensureAccountBinding = async () => {};

  try {
    for (const mention of [true, false]) {
      for (accountCount of [1, 2]) {
        const sent: any[] = [];
        let claimed = false;
        const service = new AutoDailyService({
          db: {
            claimSlot: () => {
              if (claimed) return false;
              claimed = true;
              return true;
            },
            get: async () => "tw",
          },
          users: {
            fetch: async () => ({
              send: async (payload: any) => sent.push(payload),
            }),
          },
        } as any);
        const config = {
          time: 18,
          auto_balance: false,
          notify: true,
          notify_method: "dm" as const,
          mention,
        };

        await service.processUser("99", config);
        assert.equal(
          sent.length,
          1,
          "Failed attendance must send one error notification, without a separate mention-only message",
        );
        assert.equal(sent[0].content.startsWith("<@99>\n"), mention);
        for (let i = 1; i <= accountCount; i++) {
          assert.ok(sent[0].content.includes(`Expired account ${i}:`));
        }
        await service.processUser("99", config);
        assert.equal(
          sent.length,
          1,
          "A claimed daily slot must not notify again",
        );
      }
    }

    const sent: any[] = [];
    const service = new AutoDailyService({
      db: { claimSlot: () => true, get: async () => "tw" },
      users: {
        fetch: async () => ({
          send: async (payload: any) => sent.push(payload),
        }),
      },
    } as any);
    await service.processUser("99", {
      time: 18,
      auto_balance: false,
      notify: false,
      notify_method: "dm",
    });
    assert.equal(sent.length, 0, "Disabled notifications must stay disabled");
    console.log("AutoDaily notification checks passed");
  } finally {
    Object.assign(accountUtils, originals);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
