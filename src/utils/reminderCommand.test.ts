import assert from "node:assert/strict";
import command from "../commands/general/reminder";
import { CustomDatabase } from "./Database";
import { createTranslator } from "./i18n";

async function main() {
  const json: any = command.data.toJSON();
  assert.deepEqual(json.options.map((o: any) => o.name), ["setup", "list"]);
  assert.deepEqual(json.options.map((o: any) => o.name_localizations["zh-TW"]), ["設定", "列表"]);

  const db = new CustomDatabase(":memory:");
  const client: any = { db };
  const tr = createTranslator("en");
  const calls: string[] = [];
  const make = (extra: any) => ({
    user: { id: "5" },
    deferReply: async () => void calls.push("deferReply"),
    deferUpdate: async () => void calls.push("deferUpdate"),
    editReply: async () => void calls.push("editReply"),
    reply: async (p: any) => void calls.push("reply:" + p.content),
    deleteReply: async () => void calls.push("deleteReply"),
    isChatInputCommand: () => false,
    ...extra,
  });

  // /reminder list -> the list screen
  await command.execute(
    client,
    make({ isChatInputCommand: () => true, options: { getSubcommand: () => "list" } }) as any,
    tr,
    db,
  );
  assert.deepEqual(calls, ["deferReply", "editReply"]);

  // list components never reach the wizard (which would call them an expired session)
  calls.length = 0;
  await command.execute(client, make({ customId: "reminder:list:close" }) as any, tr, db);
  assert.deepEqual(calls, ["deferUpdate", "deleteReply"]);

  // wizard components still go to the wizard: unknown token -> "expired" reply
  calls.length = 0;
  await command.execute(client, make({ customId: "reminder:abcdef0123456789:account" }) as any, tr, db);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^reply:.*(expired|逾期)/);

  console.log("reminder command routing tests passed");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
