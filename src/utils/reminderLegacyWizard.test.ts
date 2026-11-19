import assert from "node:assert/strict";
import { CustomDatabase } from "./Database";
import { migrateLegacyMonitorConfig } from "./reminderMigration";
import { reminderWizard } from "./reminderWizard";
import { MonitorService } from "../services/MonitorService";
import { ReminderConfig, reminderKey } from "./reminders";

const accountUtils = require("./accountUtils");
const skport = require("./skportApi");

const detail = {
  base: { name: "Role", roleId: "7", serverName: "Asia" },
  dungeon: { curStamina: "10", maxStamina: "240", maxTs: "0" },
  dailyMission: { dailyActivation: 100, maxDailyActivation: 100 },
};

async function main() {
  const db = new CustomDatabase(":memory:");
  const account = {
    info: { id: "1001", nickname: "Acc" },
    roles: [{ gameId: 3, roles: [{ roleId: "7", serverId: "2", nickname: "Role" }] }],
  };
  await db.set("99.accounts", [account]);
  await db.set("monitorConfig", {
    "99": { stamina_notify: true, stamina_offset: 30, mission_notify: false, notify_method: "dm" },
  });
  const originals = [accountUtils.getAccounts, accountUtils.withAutoRefresh, skport.getCardDetail];
  try {
    accountUtils.getAccounts = async () => [account];
    accountUtils.withAutoRefresh = async (_c: any, _u: any, _a: any, request: any) => request("c", "s", {});
    skport.getCardDetail = async () => ({ code: 0, data: { detail } });

    await migrateLegacyMonitorConfig(db, async () => [account]);
    const key = "reminder.v2.99.1001.2.7";
    const migrated = (await db.get<ReminderConfig>(key))!;
    assert.equal(migrated.value, 1, "stored with a placeholder until the real maximum is known");
    assert.equal(migrated.legacyOffset, 30);

    // the user opens the wizard before any poll resolved the threshold
    let screen: any;
    const interaction: any = {
      user: { id: "99" },
      isChatInputCommand: () => true,
      deferReply: async () => {},
      deferUpdate: async () => {},
      editReply: async (p: any) => {
        screen = p;
      },
      followUp: async (p: any) => {
        throw new Error(p.content);
      },
      reply: async (p: any) => {
        throw new Error(p.content);
      },
      showModal: async () => {},
    };
    await reminderWizard({ db } as any, interaction, "en");
    const sessionKey = (await db.findIdsByPrefix("reminderWizard.session.v1."))[0];
    const token = sessionKey.split(".").pop()!;
    assert.ok(
      !JSON.stringify(screen).includes("Legacy settings found"),
      "a user whose settings were migrated is not told to import a draft",
    );
    interaction.isChatInputCommand = () => false;
    const step = async (action: string, extra: any = {}) => {
      interaction.customId = `reminder:${token}:${action}`;
      interaction.values = extra.values || [];
      interaction.fields = extra.fields;
      await reminderWizard({ db } as any, interaction, "en");
    };
    await step("account", { values: ["1001"] });
    await step("role", { values: ["1001|2|7"] });
    const session = (await db.get<any>(sessionKey))!;
    assert.equal(session.config.value, 210, "the wizard shows the real threshold (240 - 30), not the placeholder");
    assert.equal(session.config.legacyOffset, undefined);

    // the user chooses their own amount and saves
    await step("sanity");
    await step("amountModalSubmit", { fields: { getTextInputValue: () => "150" } });
    await step("review");
    await step("save");
    const saved = (await db.get<ReminderConfig>(key))!;
    assert.equal(saved.value, 150);
    assert.equal(saved.sanity, "amount");
    assert.equal(saved.legacyOffset, undefined, "legacy marker is cleared on save");

    // later polls must not overwrite it
    const service = new MonitorService({ db, cluster: { id: 0 }, isReady: () => true } as any);
    await service.runMonitoring();
    assert.equal((await db.get<ReminderConfig>(key))!.value, 150);
    assert.equal(reminderKey(saved), key);
  } finally {
    [accountUtils.getAccounts, accountUtils.withAutoRefresh, skport.getCardDetail] = originals;
  }
  console.log("legacy reminder wizard tests passed");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
