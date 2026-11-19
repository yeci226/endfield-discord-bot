import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildIconIndex,
  getLocalIconIndex,
  ICON_INDEX_REFRESH_MS,
  localIconCandidateNames,
  pickLocalIconPaths,
  resetLocalIconIndex,
} from "./iconLoader";

// The probing the loader did before the index existed (one existsSync per candidate).
function oldProbe(dirs: string[], isCharacter: boolean, cid: string): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of localIconCandidateNames(isCharacter, cid)) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

function main() {
  assert.deepEqual(localIconCandidateNames(true, "chr_1"), [
    "icon_chr_1.png",
    "icon_chr_1.webp",
    "icon_chr_1.jpg",
  ]);
  assert.deepEqual(localIconCandidateNames(false, "wpn_1"), [
    "wpn_1.png",
    "wpn_1.webp",
    "wpn_1.jpg",
    "icon_wpn_1.png",
    "icon_wpn_1.webp",
    "icon_wpn_1.jpg",
  ]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icon-index-"));
  try {
    const a = path.join(root, "remote_cache");
    const b = path.join(root, "cache");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const touch = (dir: string, name: string) =>
      fs.writeFileSync(path.join(dir, name), "x");
    touch(a, "icon_chr_1.webp");
    touch(b, "icon_chr_1.png"); // earlier extension, but in the later directory
    touch(a, "icon_chr_2.jpg");
    touch(b, "wpn_1.jpg");
    touch(b, "icon_wpn_1.png");
    touch(a, "icon_wpn_1.webp");
    touch(a, "unrelated.png");

    const dirs = [a, b];
    const index = buildIconIndex(dirs);
    const table: Array<[boolean, string]> = [
      [true, "chr_1"],
      [true, "chr_2"],
      [true, "chr_3"],
      [false, "wpn_1"],
      [false, "wpn_2"],
      [true, "wpn_1"],
    ];
    for (const [isChar, cid] of table) {
      assert.deepEqual(
        pickLocalIconPaths(index, localIconCandidateNames(isChar, cid)),
        oldProbe(dirs, isChar, cid),
        `${isChar} ${cid}`,
      );
    }
    // directory order wins over extension order
    assert.equal(
      pickLocalIconPaths(index, localIconCandidateNames(true, "chr_1"))[0],
      path.join(a, "icon_chr_1.webp"),
    );

    // missing directory = empty index, no throw
    assert.deepEqual(
      pickLocalIconPaths(
        buildIconIndex([path.join(root, "nope")]),
        localIconCandidateNames(true, "chr_1"),
      ),
      [],
    );

    // refreshed at most every 10 minutes
    resetLocalIconIndex();
    const first = getLocalIconIndex(1_000, dirs);
    touch(a, "icon_chr_9.png");
    assert.equal(getLocalIconIndex(1_000 + ICON_INDEX_REFRESH_MS - 1, dirs), first);
    const second = getLocalIconIndex(1_000 + ICON_INDEX_REFRESH_MS, dirs);
    assert.notEqual(second, first);
    assert.deepEqual(
      pickLocalIconPaths(second, localIconCandidateNames(true, "chr_9")),
      [path.join(a, "icon_chr_9.png")],
    );
  } finally {
    resetLocalIconIndex();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
