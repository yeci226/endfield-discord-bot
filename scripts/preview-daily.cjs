// Run after npm run build: node scripts/preview-daily.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const moment = require("moment-timezone");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { buildDailyAttendanceCard } = require("../dist/utils/dailyCanvasUtils");
const { createTranslator } = require("../dist/utils/i18n");

async function main() {
  const output = path.resolve(__dirname, "../.tmp-layout/daily-preview");
  fs.mkdirSync(output, { recursive: true });
  const realNow = moment.now;
  const now = Date.parse("2026-09-22T04:00:00Z");
  const payload = {
    roleName: "管理員", roleMeta: "Lv.60 - Asia", gameId: 3,
    totalDays: 10, calendarTotalDays: 30, todayClaimedNow: true,
    yesterdayReward: { name: "yesterday", done: true },
    todayReward: { name: "折金票 x1000", done: true },
    nextRewards: [{ name: "tomorrow" }], tr: createTranslator("tw"),
  };
  try {
    moment.now = () => now;
    const success = await buildDailyAttendanceCard(payload);
    fs.writeFileSync(path.join(output, "today-success.png"), success);
    assert.deepEqual(await buildDailyAttendanceCard(payload), success, "Same day must be stable");
    assert.deepEqual(await buildDailyAttendanceCard({
      ...payload, totalDays: 999, calendarTotalDays: 999,
      get yesterdayReward() { throw Error("Endfield must not read yesterday"); },
      get nextRewards() { throw Error("Endfield must not read future rewards"); },
    }), success, "Endfield must only show today's data");
    const already = await buildDailyAttendanceCard({ ...payload, todayClaimedNow: false });
    assert.deepEqual(already, success, "Check-in status must not appear on the landscape card");
    fs.writeFileSync(path.join(output, "today-already.png"), already);
    assert.notDeepEqual(await buildDailyAttendanceCard({
      ...payload, todayReward: { ...payload.todayReward, name: "折金票 x2000" },
    }), success, "Reward quantity must be visible");
    fs.writeFileSync(path.join(output, "english-long-name.png"), await buildDailyAttendanceCard({
      ...payload, roleName: "Administrator with a very long account name for layout verification",
      todayClaimedNow: false, todayReward: { name: "Intermediate Combat Record x20", done: false },
      tr: createTranslator("en"),
    }));
    fs.writeFileSync(path.join(output, "multiple-rewards.png"), await buildDailyAttendanceCard({
      ...payload, todayReward: { name: "折金票 x1000\n中級作戰紀錄 x5", done: true },
    }));
    const arknights = await buildDailyAttendanceCard({ ...payload, gameId: 1 });
    fs.writeFileSync(path.join(output, "arknights-unchanged.png"), arknights);
    const before = path.resolve(__dirname, "../.tmp-layout/arknights-daily-before.png");
    if (fs.existsSync(before)) assert.deepEqual(arknights, fs.readFileSync(before), "Arknights pixels must remain unchanged");

    assert.deepEqual(await buildDailyAttendanceCard({
      ...payload, todayReward: { ...payload.todayReward, icon: "invalid://reward-icon" },
    }), success, "An unavailable icon must retain the text-only layout");
    payload.todayReward.icon = "https://endfieldtools.dev/assets/images/endfield/itemicon/item_gold.png";
    const withIcon = await buildDailyAttendanceCard(payload);
    assert.notDeepEqual(withIcon, success, "The actual reward icon must be visible");
    fs.writeFileSync(path.join(output, "today-success-with-icon.png"), withIcon);
    assert.deepEqual(await buildDailyAttendanceCard({ ...payload, avatarUrl: "invalid://avatar" }), withIcon,
      "A failed avatar must retain the fallback player row");
    payload.avatarUrl = "https://endfieldtools.dev/assets/images/endfield/charicon/icon_chr_0009_azrila.png";
    payload.roleLevel = 60;
    const withAvatar = await buildDailyAttendanceCard(payload);
    assert.notDeepEqual(withAvatar, withIcon, "The player avatar must be visible");
    fs.writeFileSync(path.join(output, "today-player-row.png"), withAvatar);
    fs.writeFileSync(path.join(output, "long-player-row.png"), await buildDailyAttendanceCard({
      ...payload, roleName: "Administrator with a very long account name for layout verification".repeat(3),
    }));

    const backgrounds = fs.readdirSync(path.resolve(__dirname, "../dist/assets/daily/endfield"))
      .filter((file) => /\.(jpg|jpeg|png|webp)$/i.test(file)).sort();
    const sheet = createCanvas(1280, Math.ceil(backgrounds.length / 3) * 264);
    const ctx = sheet.getContext("2d");
    ctx.fillStyle = "#182126";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    const day = Math.floor(moment.utc("2026-09-22").valueOf() / 86400000);
    for (let i = 0; i < backgrounds.length; i++) {
      // Use the actual daily rotation; do not add a preview-only background API.
      const offset = (i - day % backgrounds.length + backgrounds.length) % backgrounds.length;
      moment.now = () => now + offset * 86400000;
      const buffer = await buildDailyAttendanceCard(payload);
      const image = await loadImage(buffer);
      assert.equal(image.width, 1280);
      assert.equal(image.height, 720);
      if (offset) assert.notDeepEqual(buffer, success, "Different days must rotate the scene");
      fs.writeFileSync(path.join(output, backgrounds[i].replace(/\.[^.]+$/, ".png")), buffer);
      const x = (i % 3) * 426, y = Math.floor(i / 3) * 264;
      ctx.drawImage(image, x, y, 426, 240);
      ctx.fillStyle = "white";
      ctx.font = "13px sans-serif";
      ctx.fillText(backgrounds[i], x + 8, y + 257);
    }
    fs.writeFileSync(path.join(output, "all-backgrounds.jpg"), sheet.toBuffer("image/jpeg"));
    console.log(`Daily checks passed; ${backgrounds.length} landscape previews: ${output}`);
  } finally {
    moment.now = realNow;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
