import assert from "node:assert/strict";

const gachaCommand = require("../commands/general/gacha").default;

async function main() {
  const events: string[] = [];
  const userId = "123456789012345678";
  const db: any = {
    get: async () => {
      events.push("db.get");
      return [];
    },
  };
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

void main();
