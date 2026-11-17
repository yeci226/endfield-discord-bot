import assert from "node:assert/strict";
import { getGachaIconUrlCandidates } from "./gachaCanvasUtils";

function main() {
  assert.deepEqual(
    getGachaIconUrlCandidates(false, "wpn_funnel_0019"),
    [
      "https://bbs.hycdn.cn/image/common/20260902/4826366/6a977074c40accef2ad54999_f1525633.png",
    ],
  );

  assert.deepEqual(
    getGachaIconUrlCandidates(false, "wpn_lance_0014"),
    [
      "https://bbs.hycdn.cn/image/common/20260808/4634516/6a772fb96febdf01b964b1e2_f1525633.png",
    ],
  );

  assert.deepEqual(
    getGachaIconUrlCandidates(false, "wpn_lance_9999"),
    [],
  );

  assert.deepEqual(
    getGachaIconUrlCandidates(false, "icon_wpn_lance_0014"),
    getGachaIconUrlCandidates(false, "wpn_lance_0014"),
  );

  assert.deepEqual(
    getGachaIconUrlCandidates(true, "chr_0034_typhoea"),
    [
      "https://bbs.hycdn.cn/image/common/20260902/221109/6a9772282e39b624e0143815_3eac6ad0.png",
    ],
  );

  assert.deepEqual(
    getGachaIconUrlCandidates(true, "icon_chr_0009_azrila"),
    [
      "https://bbs.hycdn.cn/image/common/20260217/2054140/69940065223662a892b01da4_db193eac.png",
    ],
  );

  assert.deepEqual(getGachaIconUrlCandidates(true, "chr_9999_unknown"), []);
}

main();
