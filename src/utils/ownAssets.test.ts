import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveOwnAssetRel } from "./ownAssets";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ef-own-assets-"));
fs.mkdirSync(path.join(root, "weapon", "black"), { recursive: true });
fs.mkdirSync(path.join(root, "cache"), { recursive: true });
fs.writeFileSync(path.join(root, "weapon", "black", "sword.png"), "x");
fs.writeFileSync(path.join(root, "有 空格.png"), "x");
fs.writeFileSync(path.join(root, "cache", "a.png"), "x");
fs.writeFileSync(path.join(root, "notes.txt"), "x");
fs.writeFileSync(path.join(path.dirname(root), "outside.png"), "x");

const r = (url: string) => resolveOwnAssetRel(url, root);

try {
  // any host: the editor domain has changed and old templates keep the old one
  assert.equal(r("https://editor.old.test/assets/weapon/black/sword.png"), "weapon/black/sword.png");
  assert.equal(r("https://editor.new.test/assets/weapon/black/sword.png"), "weapon/black/sword.png");
  assert.equal(r("http://localhost:3838/endfield/assets/weapon/black/sword.png?v=2"), "weapon/black/sword.png");
  assert.equal(r("https://e.test/assets/" + encodeURIComponent("有 空格.png")), "有 空格.png");

  // not ours
  assert.equal(r("https://e.test/assets/weapon/black/missing.png"), null);
  assert.equal(r("https://e.test/api/profile/x"), null);
  assert.equal(r("https://e.test/assets/notes.txt"), null);
  assert.equal(r("https://e.test/assets/cache/a.png"), null);
  assert.equal(r("/assets/weapon/black/sword.png"), null); // relative: not this helper's job
  assert.equal(r("ftp://e.test/assets/weapon/black/sword.png"), null);

  // traversal, raw and encoded
  assert.equal(r("https://e.test/assets/../outside.png"), null);
  assert.equal(r("https://e.test/assets/%2e%2e/outside.png"), null);
  assert.equal(r("https://e.test/assets/weapon/%2e%2e%2f%2e%2e%2foutside.png"), null);
  assert.equal(r("https://e.test/assets/weapon%5c..%5c..%5coutside.png"), null);
  assert.equal(r("https://e.test/assets//etc/passwd.png"), null);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(root), "outside.png"), { force: true });
}
