import assert from "node:assert/strict";
import { CustomDatabase } from "./Database";

const command = require("../commands/general/gacha").default;

async function main() {
  const db = new CustomDatabase(":memory:");
  const owner = "123456789012345678";
  const prefix = `GACHA_LOG_EF_GUEST_${owner}_`;
  const requested: string[] = [];
  const replies: any[] = [];
  const targetUser = { id: owner, toString: () => `<@${owner}>` };
  const interaction: any = {
    locale: "zh-TW",
    user: { id: "999999999999999999" },
    isChatInputCommand: () => true,
    isStringSelectMenu: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    options: {
      getSubcommandGroup: () => "log",
      getSubcommand: () => "view",
      getUser: () => targetUser,
      getString: () => null,
    },
    deferReply: async () => undefined,
    editReply: async (reply: unknown) => replies.push(reply),
  };
  const tr: any = (key: string) => key;
  tr.lang = "tw";

  // Stop after account selection; rendering and network imports are unrelated.
  db.get = async (key) => {
    if (key.startsWith("GACHA_LOG_")) requested.push(key);
    return null;
  };
  db.findByPrefix = async () => {
    throw new Error("must not load and parse complete gacha histories");
  };

  try {
    // Unrelated malformed JSON must never be parsed by this lookup.
    (db as any).db
      .prepare("INSERT INTO json (ID, json) VALUES (?, ?)")
      .run("GACHA_LOG_EF_987654321", "invalid JSON");
    await command.execute({}, interaction, tr, db);
    assert.deepEqual(requested, []);
    assert.equal(replies[replies.length - 1]?.content, "gacha_log_NoData");

    await db.set(`${prefix}older`, { info: { export_timestamp: 10 } });
    await db.set(`${prefix}newer`, { info: { export_timestamp: 20 } });
    await db.set(`${prefix}missing`, { info: {} });
    await db.set(`GACHA_LOG_EF_GUEST_${owner}Xcollision`, {
      info: { export_timestamp: 999 },
    });
    await db.set("GACHA_LOG_EF_GUEST_999999999999999999_other", {
      info: { export_timestamp: 1000 },
    });
    await command.execute({}, interaction, tr, db);
    assert.deepEqual(requested, [`${prefix}newer`]);
    console.log("guest gacha lookup regression tests passed");
  } finally {
    (db as any).db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
