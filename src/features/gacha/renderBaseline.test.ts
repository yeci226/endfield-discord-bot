import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

// The fixture lives in scripts/ (outside tsconfig's rootDir), so run it as a
// child process and compare the hashes it prints with the stored baseline.
const root = path.join(__dirname, "..", "..", "..");
const baseline = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "__fixtures__", "render-baseline.json"),
    "utf8",
  ),
);

// Render once with the card cache on (the fixture also checks a repeat render
// returns the identical buffer) and once with it bypassed: same pixels.
for (const noCardCache of ["0", "1"]) {
  const res = spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register",
      path.join(root, "scripts", "render-gacha-fixture.ts"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: "1",
        NODE_ENV: "test",
        RENDER_FIXTURE_NO_CARD_CACHE: noCardCache,
      },
    },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), baseline);
}
