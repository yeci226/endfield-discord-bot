import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCommandsFrom } from "./commandHandler";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ef-cmd-test-"));
  try {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(
      path.join(dir, "good.js"),
      'exports.default = { data: { name: "good" }, execute() {} };',
    );
    fs.writeFileSync(
      path.join(dir, "sub", "nested.js"),
      'exports.default = { data: { name: "nested" }, execute() {} };',
    );
    fs.writeFileSync(
      path.join(dir, "throws.js"),
      'throw new Error("bad import");',
    );
    fs.writeFileSync(path.join(dir, "helper.js"), "exports.helper = 1;");
    fs.writeFileSync(
      path.join(dir, "good.test.js"),
      'throw new Error("test file must not be imported");',
    );

    const client = { commands: new Map<string, any>() };
    const result = await loadCommandsFrom(client as any, dir);

    assert.deepEqual([...client.commands.keys()].sort(), ["good", "nested"]);
    assert.deepEqual([...result.loaded].sort(), ["good", "nested"]);
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].endsWith("throws.js"));
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0].endsWith("helper.js"));
    console.log("commandHandler tests passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
