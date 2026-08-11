import assert from "node:assert/strict";
import { getGachaIconUrlCandidates } from "./gachaCanvasUtils";

function main() {
  assert.deepEqual(
    getGachaIconUrlCandidates(false, "wpn_lance_0014"),
    [
      "https://bbs.hycdn.cn/image/common/20260808/4634516/6a772fb96febdf01b964b1e2_f1525633.png",
      "https://endfieldtools.dev/assets/images/endfield/itemicon/wpn_lance_0014.png",
      "https://endfield.ooo.run/ake/weapons/wpn_lance_0014.webp",
    ],
  );

  assert.deepEqual(
    getGachaIconUrlCandidates(false, "wpn_lance_9999"),
    [
      "https://endfieldtools.dev/assets/images/endfield/itemicon/wpn_lance_9999.png",
      "https://endfield.ooo.run/ake/weapons/wpn_lance_9999.webp",
    ],
  );

  assert.deepEqual(
    getGachaIconUrlCandidates(false, "icon_wpn_lance_0014"),
    getGachaIconUrlCandidates(false, "wpn_lance_0014"),
  );

  assert.deepEqual(
    getGachaIconUrlCandidates(true, "chr_0009_azrila"),
    [
      "https://endfieldtools.dev/assets/images/endfield/charicon/icon_chr_0009_azrila.png",
    ],
  );
}

main();
