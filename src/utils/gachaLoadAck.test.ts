import assert from "node:assert/strict";
import { CustomDatabase } from "./Database";

const gachaCommand = require("../commands/general/gacha").default;

async function main() {
  const events: string[] = [];
  const userId = "123456789012345678";
  // A real in-memory database that records its accesses, so the test keeps
  // working when the code under test starts using newer db methods.
  const db = new CustomDatabase(":memory:");
  const realGet = db.get.bind(db);
  db.get = (async (key: string) => {
    events.push("db.get");
    return realGet(key);
  }) as typeof db.get;
  const realTransaction = db.transaction.bind(db);
  db.transaction = ((cb: any) => {
    events.push("db.transaction");
    return realTransaction(cb);
  }) as typeof db.transaction;
  const interaction: any = {
    locale: "zh-TW",
    user: { id: userId },
    isChatInputCommand: () => true,
    isStringSelectMenu: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    options: {
      getSubcommandGroup: () => "log",
      getSubcommand: () => "load",
      getString: () => null,
    },
    deferReply: async () => {
      events.push("defer");
    },
    editReply: async () => {
      events.push("editReply");
    },
    deleteReply: async () => {
      events.push("deleteReply");
    },
    followUp: async () => {
      events.push("followUp");
    },
  };
  const translate: any = (key: string) => key;
  translate.lang = "zh-TW";

  await gachaCommand.execute({}, interaction, translate, db);
  assert.equal(
    events[0],
    "defer",
    "gacha log load must acknowledge before account/database work when no option is selected",
  );
  console.log("gacha log load acknowledgement regression test passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
