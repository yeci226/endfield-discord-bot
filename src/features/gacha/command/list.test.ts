import assert from "node:assert/strict";
import { CustomDatabase } from "../../../utils/Database";

const skport = require("../../../utils/skportApi") as {
  getCharacterPool: (...a: any[]) => Promise<any>;
  getWeaponPool: (...a: any[]) => Promise<any>;
};
const original = { c: skport.getCharacterPool, w: skport.getWeaponPool };

import { handleGachaList } from "./list";

const pool = (name: string, key: "chars" | "weapons", pics: string[]) => ({
  id: name,
  name,
  poolStartAtTs: 1_760_000_000,
  poolEndAtTs: 1_770_000_000,
  chars: key === "chars" ? pics.map((pic) => ({ name: "c", pic })) : [],
  weapons: key === "weapons" ? pics.map((pic) => ({ name: "w", pic })) : [],
});

async function render(
  char: any,
  weapon: any,
  db: CustomDatabase = new CustomDatabase(":memory:"),
) {
  skport.getCharacterPool = async () => char;
  skport.getWeaponPool = async () => weapon;
  const replies: any[] = [];
  const interaction: any = {
    user: { id: "111111111111111111" },
    locale: "zh-TW",
    deferReply: async () => {},
    editReply: async (o: any) => replies.push(o),
    followUp: async () => {},
  };
  const tr: any = Object.assign(
    (k: string, p?: Record<string, string>) =>
      p ? `${k}|${Object.values(p).join(",")}` : k,
    { lang: "tw" },
  );
  await handleGachaList(
    { client: {} as any, interaction, tr, db } as any,
    interaction,
  );
  return JSON.stringify(replies[0].components[0].toJSON());
}

async function main() {
  try {
    // both banners shown, same visual language
    let json = await render(
      { code: 0, data: { list: [pool("角色池", "chars", ["https://img/c1.png"])] } },
      { code: 0, data: { list: [pool("武器池", "weapons", ["https://img/w1.png", "https://img/w2.png"])] } },
    );
    assert.ok(json.includes("## 角色池"));
    assert.ok(json.includes("## 武器池"), "weapon banner is shown");
    assert.ok(json.includes("https://img/w1.png") && json.includes("https://img/w2.png"));
    assert.ok(json.includes("gacha_Asia_End"), "weapon banner has the same end-time lines");
    assert.ok(json.indexOf("## 角色池") < json.indexOf("## 武器池"));
    assert.equal((json.match(/gacha_Global_End/g) || []).length, 2);

    // no active weapon pool: one-line note, character block unaffected
    json = await render(
      { code: 0, data: { list: [pool("角色池", "chars", ["https://img/c1.png"])] } },
      { code: 0, data: { list: [] } },
    );
    assert.ok(json.includes("## 角色池"));
    assert.ok(json.includes("gacha_WeaponEmpty"));

    // weapon API failure still renders the character banners
    json = await render(
      { code: 0, data: { list: [pool("角色池", "chars", [])] } },
      null,
    );
    assert.ok(json.includes("gacha_WeaponEmpty"));

    // expired token: only the token message
    json = await render({ code: 10000 }, undefined);
    assert.ok(json.includes("TokenExpired"));
    assert.ok(!json.includes("gacha_WeaponEmpty"));

    // a gallery never exceeds Discord's 10 items
    json = await render(
      { code: 0, data: { list: [] } },
      {
        code: 0,
        data: {
          list: [pool("武器池", "weapons", Array.from({ length: 14 }, (_, i) => `https://img/w${i}.png`))],
        },
      },
    );
    assert.equal((json.match(/https:\/\/img\/w\d+\.png/g) || []).length, 10);

    // the lists' pictures are remembered as icon fallbacks (ids come from the file names)
    const iconDb = new CustomDatabase(":memory:");
    const hy = "https://bbs.hycdn.cn/image/common/2026/icon_chr_0099_newguy.png";
    await render(
      { code: 0, data: { list: [pool("角色池", "chars", [hy, "https://img/other.png"])] } },
      { code: 0, data: { list: [] } },
      iconDb,
    );
    assert.deepEqual(await iconDb.get("GACHA_ICON_URLS"), { chr_0099_newguy: hy });
    // a second call with nothing new leaves the row alone
    const before = iconDb.getRowToken("GACHA_ICON_URLS")!.length;
    await render(
      { code: 0, data: { list: [pool("角色池", "chars", [hy])] } },
      { code: 0, data: { list: [] } },
      iconDb,
    );
    assert.equal(iconDb.getRowToken("GACHA_ICON_URLS")!.length, before);

    console.log("gacha list tests passed");
  } finally {
    skport.getCharacterPool = original.c;
    skport.getWeaponPool = original.w;
  }
}

void main();
