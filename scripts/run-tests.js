const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const filter = process.argv[2] || "";

function collect(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(collect(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const knownPath = path.join(__dirname, "known-failing-tests.json");
const known = new Set(
  fs.existsSync(knownPath) ? JSON.parse(fs.readFileSync(knownPath, "utf8")) : [],
);

const files = collect(path.join(root, "src"))
  .map((f) => path.relative(root, f).split(path.sep).join("/"))
  .sort()
  .filter((f) => !filter || f.includes(filter));

let passed = 0;
let failed = 0;
let knownFailing = 0;

for (const rel of files) {
  const res = spawnSync(
    process.execPath,
    ["-r", "ts-node/register", path.join(root, rel)],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1", NODE_ENV: "test" },
    },
  );
  const ok = res.status === 0 && !res.error;
  if (ok) {
    passed++;
    console.log(
      known.has(rel) ? `PASS (remove from known-failing) ${rel}` : `PASS ${rel}`,
    );
  } else if (known.has(rel)) {
    knownFailing++;
    console.log(`KNOWN-FAIL ${rel}`);
  } else {
    failed++;
    console.log(`FAIL ${rel}`);
    if (res.error) console.log(String(res.error));
    if (res.stderr) console.log(res.stderr);
  }
}

console.log(`${passed} passed, ${failed} failed, ${knownFailing} known-failing`);
process.exit(failed > 0 ? 1 : 0);
