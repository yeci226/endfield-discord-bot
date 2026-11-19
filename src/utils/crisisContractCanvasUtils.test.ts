import assert from "node:assert/strict";
import { loadImage } from "@napi-rs/canvas";
import {
  buildCrisisContractCard,
  contractChoices,
  CRISIS_CONTRACT_CARD_SIZE,
  listContracts,
  pickDefaultContract,
  resolveContract,
} from "./crisisContractCanvasUtils";
import { createTranslator } from "./i18n";

async function main() {
  const png = await buildCrisisContractCard({
    roleName: "Tester",
    roleLevel: 60,
    crisisContract: {
      status: {
        name: "測試行動",
        highest: 28,
        challengeCount: 3,
        weeklyMission: { count: 2, total: 3 },
        indicatorMission: { count: 8, total: 12 },
        stageMission: { count: 1, total: 1 },
      },
      indicators: Array.from({ length: 8 }, (_, i) => ({ id: String(i) })),
      history: {
        records: [{ id: "r1" }],
        bestRecord: {
          passTs: 425,
          indicatorCount: 8,
          chars: [
            { charId: "1", level: 90, potentialLevel: 2 },
            { charId: "2", level: 90, potentialLevel: 1 },
            { charId: "3", level: 80, potentialLevel: 5 },
            { charId: "4", level: 90, potentialLevel: 3 },
          ],
        },
      },
    },
    detail: {
      chars: [
        { id: "1", weapon: { level: 90, refineLevel: 3 } },
        { id: "2", weapon: { level: 90, refineLevel: 2 } },
        { id: "3", weapon: { level: 80, refineLevel: 1 } },
        { id: "4", weapon: { level: 90, refineLevel: 4 } },
      ],
    },
  });

  const image = await loadImage(png);
  assert.equal(image.width, CRISIS_CONTRACT_CARD_SIZE.width);
  assert.equal(image.height, CRISIS_CONTRACT_CARD_SIZE.height);
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

  // The English card renders at the same size (no hard-coded Chinese layout assumptions).
  const en = await loadImage(
    await buildCrisisContractCard({ roleName: "Tester", roleLevel: 60, crisisContract: { status: { name: "Season" }, indicators: [], history: {} }, tr: createTranslator("en") }),
  );
  assert.equal(en.width, CRISIS_CONTRACT_CARD_SIZE.width);

  // Every card string goes through tr(): both languages define each key.
  for (const key of ["crisis_Card_Result", "crisis_Card_Success", "crisis_Card_Total", "crisis_Card_Time", "crisis_Card_Milestone", "crisis_Card_Challenges", "crisis_Card_Weapon", "crisis_Title"]) {
    assert.notEqual(createTranslator("tw")(key), key);
    assert.notEqual(createTranslator("en")(key), key);
  }
  assert.equal(createTranslator("en")("crisis_Card_Challenges", { challenges: 3, records: 4 }), "Challenges 3 / Records 4");

  // Season list comes from card/detail.crisisContract[]; no hard-coded id.
  const detail = {
    crisisContract: [
      { id: "a", name: "Season A", highest: 10, challengeCount: 2 },
      { id: "b", name: "Season B", highest: 36, challengeCount: 5 },
      { name: "no id" },
      null,
    ],
  };
  const list = listContracts(detail);
  assert.deepEqual(list.map((c) => c.id), ["a", "b"]);
  assert.equal(pickDefaultContract(list)?.id, "b");
  assert.equal(pickDefaultContract([]), undefined);
  assert.deepEqual(resolveContract(list, null), { contract: list[1] });
  assert.deepEqual(resolveContract(list, "a"), { contract: list[0] });
  assert.deepEqual(resolveContract(list, "zzz"), { error: "notFound" });
  assert.deepEqual(resolveContract([], undefined), { error: "none" });
  assert.deepEqual(listContracts({}), []);
  assert.deepEqual(listContracts(null), []);
  assert.deepEqual(contractChoices(list, "season b"), [{ name: "Season B", value: "b" }]);
  assert.equal(contractChoices(list, "").length, 2);
  assert.equal(contractChoices(Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: `S${i}` })), "").length, 25);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
