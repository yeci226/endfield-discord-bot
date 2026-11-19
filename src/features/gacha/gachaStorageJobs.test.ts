import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CustomDatabase } from "../../utils/Database";
import { StartupHooks } from "../../utils/startup";
import { startGachaStorageJobs } from "./gachaLeaderboard";

async function main() {
  // The function registers exactly one one-shot and one periodic hook.
  const seen: Array<{ kind: string; name: string }> = [];
  const fake = {
    onPrimary: (name: string) => void seen.push({ kind: "once", name }),
    every: (name: string) => void seen.push({ kind: "every", name }),
  };
  startGachaStorageJobs(fake as any, new CustomDatabase(":memory:"));
  assert.deepEqual(seen, [
    { kind: "once", name: "gacha-leaderboard-migrate" },
    { kind: "every", name: "gacha-leaderboard-refresh" },
  ]);

  // Hook names are unique per StartupHooks: a second call would throw, so there must be one call site.
  const hooks = new StartupHooks({ info() {}, error() {} });
  startGachaStorageJobs(hooks, new CustomDatabase(":memory:"));
  assert.throws(
    () => startGachaStorageJobs(hooks, new CustomDatabase(":memory:")),
    /already registered/,
  );
  hooks.stop();

  // One call site in the source tree (index.ts, cluster 0 block).
  const root = path.join(__dirname, "..", "..");
  const sites: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const n = (fs.readFileSync(full, "utf8").match(/startGachaStorageJobs\(/g) || []).length;
        for (let i = 0; i < n; i++) sites.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  // definition + the single call in index.ts
  assert.deepEqual(sites.sort(), ["features/gacha/gachaLeaderboard.ts", "index.ts"]);
  console.log("gachaStorageJobs ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
