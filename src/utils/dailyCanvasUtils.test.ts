// Run: node -r ts-node/register src/utils/dailyCanvasUtils.test.ts [preview-directory]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import moment from "moment-timezone";
import { createCanvas } from "@napi-rs/canvas";
import { buildDailyAttendanceCard, DailyCardPayload } from "./dailyCanvasUtils";
import { createTranslator } from "./i18n";

const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext("2d"));
const originalText = proto.fillText;
const originalNow = moment.now;
let painted: { text: string; x: number; y: number }[] = [];
proto.fillText = function (text: string, x: number, y: number) {
  painted.push({ text, x, y });
  return originalText.call(this, text, x, y);
};

async function main() {
  const output = process.argv[2];
  if (output) fs.mkdirSync(output, { recursive: true });
  const cases: [string, number[]][] = [
    ["2026-09-30", [0, 1]],
    ["2026-10-01", [1, 2, 3, 4]],
    ["2026-09-29", [0, 1, 2]],
    ["2026-09-15", [0, 1, 2, 3, 4]],
    ["2026-12-31", [0, 1]],
    ["2027-01-01", [1, 2, 3, 4]],
    ["2028-02-28", [0, 1, 2]],
  ];
  for (const [date, visible] of cases) {
    // Midnight in Taipei is still the previous UTC date.
    moment.now = () => Date.parse(`${date}T00:00:00+08:00`);
    const rewards = Array.from({ length: 5 }, (_, i) => ({
      name: "龍門幣 x500",
      resourceId: "4001",
      done: i < 2,
      get icon(): string {
        assert.ok(
          visible.includes(i),
          `${date}: hidden slot ${i} must not load an icon`,
        );
        return "";
      },
    }));
    const payload: DailyCardPayload = {
      roleName: "跨月簽到預覽",
      roleMeta: date,
      gameId: 1,
      totalDays: Number(date.slice(-2)),
      calendarTotalDays: moment().tz("Asia/Taipei").daysInMonth(),
      todayClaimedNow: true,
      yesterdayReward: rewards[0],
      todayReward: rewards[1],
      nextRewards: rewards.slice(2),
      tr: createTranslator("tw"),
    };
    painted = [];
    const image = await buildDailyAttendanceCard(payload);
    for (let i = 0; i < rewards.length; i++) {
      const left = 84 + i * 228;
      const text = painted
        .filter(
          (p) => p.x >= left && p.x < left + 200 && p.y >= 272 && p.y <= 532,
        )
        .map((p) => p.text);
      if (visible.includes(i)) {
        assert.ok(
          text.includes(
            moment()
              .tz("Asia/Taipei")
              .add(i - 1, "day")
              .format("M/D"),
          ),
          `${date}: missing date in slot ${i}`,
        );
        assert.ok(
          text.includes("龍門幣 x500"),
          `${date}: missing reward in slot ${i}`,
        );
      } else {
        assert.deepEqual(text, [], `${date}: slot ${i} must be blank`);
      }
    }
    if (date === "2026-09-30") {
      assert.deepEqual(
        await buildDailyAttendanceCard({
          ...payload,
          nextRewards: rewards.slice(2).map(() => ({
            name: "Hidden reward".repeat(30),
            done: true,
            endOfPeriod: true,
          })),
        }),
        image,
        "Hidden rewards must not affect card colors or visible text sizing",
      );
    }
    if (date === "2026-09-15") {
      painted = [];
      await buildDailyAttendanceCard({
        ...payload,
        nextRewards: [{ name: "-", endOfPeriod: true }, ...rewards.slice(3)],
      });
      assert.deepEqual(
        painted.filter(
          (p) => p.x >= 540 && p.x < 740 && p.y >= 272 && p.y <= 532,
        ),
        [],
        "Unknown rewards must remain blank",
      );
    }
    if (output) fs.writeFileSync(path.join(output, `${date}.png`), image);
  }
  console.log(
    "Daily calendar checks passed: month/year boundaries, leap day, Taipei midnight, and blank unknown rewards",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    proto.fillText = originalText;
    moment.now = originalNow;
  });
