import assert from "node:assert/strict";
import { loadImage } from "@napi-rs/canvas";
import {
  buildCrisisContractCard,
  CRISIS_CONTRACT_CARD_SIZE,
} from "./crisisContractCanvasUtils";

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
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
