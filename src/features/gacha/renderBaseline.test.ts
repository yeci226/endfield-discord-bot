import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { renderGachaFixture } from "../../../scripts/render-gacha-fixture";

async function main() {
  const baseline = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "__fixtures__", "render-baseline.json"),
      "utf8",
    ),
  );
  const actual = await renderGachaFixture();
  assert.deepEqual(actual, baseline);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
