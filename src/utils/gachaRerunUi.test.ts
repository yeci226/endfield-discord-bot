import assert from "node:assert/strict";
import { CustomDatabase } from "./Database";
import { createTranslator } from "./i18n";

const canvas = require("./gachaCanvasUtils");
const originalDraw = canvas.drawGachaStats;
const drawn: any[] = [];
canvas.drawGachaStats = async (...args: any[]) => {
  drawn.push({ stats: args[1], type: args[3], poolId: args[4] });
  return Buffer.from("test image");
};
const command = require("../commands/general/gacha").default;

async function main() {
  const db = new CustomDatabase(":memory:");
  try {
    await db.set("GACHA_LOG_test", {
      info: {
        uid: "test",
        nickname: "Test",
        lang: "zh-tw",
        export_timestamp: 1,
      },
      characterList: [
        {
          seqId: "2",
          gachaTs: "2",
          poolId: "rerun_chr_yvonne",
          poolName: "絢麗異彩",
          poolType: "E_CharacterGachaPoolType_Rerun",
          rarity: 4,
          isFree: false,
        },
        {
          seqId: "1",
          gachaTs: "1",
          poolId: "special_test",
          poolName: "特許池",
          poolType: "E_CharacterGachaPoolType_Special",
          rarity: 4,
          isFree: false,
        },
      ],
      weaponList: [],
    });
    for (const id of ["rerun_chr_yvonne", "special_test"])
      await db.set(`GACHA_POOL_METADATA_${id}`, { data: {} });
    const replies: any[] = [];
    const interaction: any = {
      user: { id: "test", displayName: "Test" },
      locale: "zh-TW",
      isChatInputCommand: () => false,
      isStringSelectMenu: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      customId: "gacha:log_type:test:all",
      values: ["rerun_char"],
      // the message this menu sits on was produced by this same user's command
      message: {
        flags: { has: () => false },
        interactionMetadata: { user: { id: "test" } },
      },
      deferUpdate: async () => {},
      editReply: async (reply: any) => replies.push(reply),
    };
    const run = async () => {
      await command.execute({}, interaction, createTranslator("tw"), db);
      return replies[replies.length - 1].components.map((row: any) =>
        row.toJSON(),
      );
    };
    let rows = await run();
    assert.deepEqual(
      rows[0].components[0].options.map((o: any) => o.value),
      ["all", "rerun_chr_yvonne"],
    );
    assert.ok(
      rows[1].components[0].options.some(
        (o: any) =>
          o.value === "rerun_char" && o.label === "重構尋訪" && o.default,
      ),
    );
    assert.equal(drawn[drawn.length - 1].type, "rerun_char");
    assert.equal(
      drawn[drawn.length - 1].stats.char.summary.RerunShared.currentPity,
      1,
    );

    // A stale category in a pool-selection interaction must auto-correct.
    interaction.customId = "gacha:log_pool:test:limited_char";
    interaction.values = ["rerun_chr_yvonne"];
    await run();
    assert.equal(drawn[drawn.length - 1].type, "rerun_char");
    assert.equal(drawn[drawn.length - 1].poolId, "rerun_chr_yvonne");

    interaction.customId = "gacha:log_type:test:all";
    interaction.values = ["limited_char"];
    rows = await run();
    assert.deepEqual(
      rows[0].components[0].options.map((o: any) => o.value),
      ["all", "special_test"],
    );
    console.log("Rerun category and pool-selection interaction tests passed");
  } finally {
    canvas.drawGachaStats = originalDraw;
    (db as any).db.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
