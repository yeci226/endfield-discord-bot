import assert from "node:assert/strict";
import { CustomDatabase } from "../../../utils/Database";

// drawGachaStats is replaced on this module on purpose (see gachaCanvasUtils.ts).
const canvasUtils = require("../../../utils/gachaCanvasUtils") as {
  drawGachaStats: (...args: any[]) => Promise<Buffer>;
};
const originalDraw = canvasUtils.drawGachaStats;
const drawn: any[] = [];
canvasUtils.drawGachaStats = async (...args: any[]) => {
  drawn.push(args);
  return Buffer.from("fake-image");
};

import {
  showGachaStats,
  isGenericNickname,
  pickDisplayNickname,
  resolveViewableGachaUid,
  handleGachaView,
} from "./view";

const UID = "EF_424242";
const LOG_KEY = `GACHA_LOG_${UID}`;

function buildLog(nickname: string) {
  const rec = (i: number, rarity: number, poolId: string, name: string) => ({
    seqId: String(100 - i),
    charId: `chr_${i}`,
    charName: `Char ${i}`,
    rarity,
    gachaTs: String(1_760_000_000_000 + i * 1000),
    poolId,
    poolName: name,
    poolType: "E_CharacterGachaPoolType_Special",
    isFree: false,
  });
  return {
    characterList: Array.from({ length: 30 }, (_, i) =>
      rec(i, i % 15 === 0 ? 6 : i % 5 === 0 ? 5 : 4, "c_special_t_1", "特選尋訪「測試」"),
    ),
    weaponList: [],
    info: {
      uid: UID,
      lang: "zh-tw",
      serverId: "2",
      nickname,
      export_timestamp: 1_760_000_100_000,
    },
  };
}

function totalChanges(db: CustomDatabase): number {
  return (db as any).db.prepare("SELECT total_changes() AS c").get().c;
}

async function setup(nickname: string) {
  const db = new CustomDatabase(":memory:");
  await db.set(LOG_KEY, buildLog(nickname));
  // Pool metadata present => the engine never goes to the network.
  await db.set("GACHA_POOL_METADATA_c_special_t_1", {
    data: {
      up6_name: "Char 0",
      up6_item_name: "Char 0",
      all: [{ id: "chr_0", name: "Char 0", rarity: 6 }],
    },
    lastFetch: 0,
  });
  const fullReads: string[] = [];
  const spy: any = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "get")
        return async (k: string) => (fullReads.push(k), target.get(k));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const replies: any[] = [];
  const ctx: any = {
    interaction: {
      user: { id: "111111111111111111", displayName: "Viewer" },
      editReply: async (o: any) => replies.push(o),
    },
    tr: Object.assign((k: string) => k, { lang: "tw" }),
    db: spy,
  };
  return { db, spy, ctx, replies, fullReads };
}

async function main() {
  try {
    // --- a view of an existing log: first view fills the cache, repeats write nothing
    {
      const { db, ctx, replies, fullReads } = await setup("羽冰");
      await showGachaStats(ctx, UID, "limited_char");
      assert.equal(replies.length, 1);
      assert.ok(replies[0].files?.length === 1, "card is attached");
      assert.ok(fullReads.includes(LOG_KEY), "first view reads the log");

      const changesBefore = totalChanges(db);
      const logLen = db.getRowToken(LOG_KEY)!.length;
      fullReads.length = 0;
      for (const [type, pool, page] of [
        ["limited_char", "", 0],
        ["limited_char", "c_special_t_1", 0],
        ["weapon", "", 0],
        ["limited_char", "c_special_t_1", 1],
      ] as const) {
        await showGachaStats(ctx, UID, type as any, pool, page);
      }
      assert.equal(totalChanges(db), changesBefore, "cache hit performs zero DB writes");
      assert.ok(!fullReads.includes(LOG_KEY), "cache hit never reads the log row");
      assert.equal(db.getRowToken(LOG_KEY)!.length, logLen);
      assert.equal(await db.get("GACHA_LEADERBOARD_ENTRIES"), null, "view must not update the leaderboard");
      assert.equal(replies.length, 5);
      // the card is drawn from the cached info block
      assert.equal(drawn[drawn.length - 1][0].info.nickname, "羽冰");
    }

    // --- a generic nickname is fixed for display only, never written back
    {
      const { db, ctx, fullReads } = await setup("Unknown");
      await showGachaStats(ctx, UID, "limited_char");
      const changesBefore = totalChanges(db);
      const raw = JSON.stringify(await db.get(LOG_KEY));
      await showGachaStats(ctx, UID, "limited_char");
      assert.equal(totalChanges(db), changesBefore, "no writes on a hit with a generic nickname");
      assert.equal(JSON.stringify(await db.get(LOG_KEY)), raw, "log row untouched");
      assert.ok(!fullReads.slice(fullReads.indexOf(LOG_KEY) + 1).includes(LOG_KEY));
    }

    // --- missing log: no card, no writes (auto-load needs a linked account; none here)
    {
      const { db, ctx, replies } = await setup("x");
      const before = totalChanges(db);
      await showGachaStats(ctx, "EF_000", "limited_char", "", 0, null, true);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].content, "gacha_log_NoData");
      assert.equal(totalChanges(db), before);
    }

    // --- view user:X account:Y — Y must be one of X's own UIDs
    {
      const OWNER = "222222222222222222";
      const VIEWER = "111111111111111111";
      const roles = [
        { uid: "EF_424242", rawUid: "424242", bindingUid: "b", nickname: "羽冰" },
        { uid: "EF_CN_424242", rawUid: "424242", bindingUid: "b", nickname: "羽冰" },
      ];
      const ok = (uid: string, owner = OWNER, r = roles) =>
        resolveViewableGachaUid(uid, owner, r).ok;
      assert.equal(ok("EF_424242"), true);
      assert.equal(ok("EF_CN_424242"), true);
      assert.equal(ok("424242"), true, "legacy bare key form of an owned role");
      assert.equal(ok(`EF_GUEST_${OWNER}_1700000000000`), true, "own guest key");
      assert.equal(ok(`EF_GUEST_${VIEWER}_1700000000000`), false, "someone else's guest key");
      assert.equal(ok(`EF_GUEST_${OWNER}X1700000000000`), false);
      assert.equal(ok(`EF_GUEST_${OWNER}_`), false, "empty guest suffix");
      assert.equal(ok("EF_999999"), false, "a UID that is nobody's of this user");
      assert.equal(ok("EF_undefined"), false, "the shared recovery key is not viewable");
      assert.equal(ok(""), false);
      assert.equal(ok("EF_424242", OWNER, []), false, "no accounts");

      // through the command handler
      const db = new CustomDatabase(":memory:");
      await db.set(`${OWNER}.accounts`, [
        {
          info: { id: "acc" },
          roles: [{ gameId: 3, uid: "b", roles: [{ roleId: "424242", nickname: "羽冰" }] }],
        },
      ]);
      await db.set(`${VIEWER}.accounts`, []);
      await db.set("GACHA_LOG_EF_555555", buildLog("Stranger")); // someone else's log
      await db.set(LOG_KEY, buildLog("羽冰"));
      await db.set("GACHA_POOL_METADATA_c_special_t_1", {
        data: { up6_name: "Char 0", all: [{ id: "chr_0", name: "Char 0", rarity: 6 }] },
        lastFetch: 0,
      });
      const run = async (accountOpt: string | null, userOpt: any) => {
        const replies: any[] = [];
        const interaction: any = {
          user: { id: VIEWER, displayName: "Viewer" },
          options: {
            getUser: () => userOpt,
            getString: () => accountOpt,
          },
          deferReply: async () => {},
          editReply: async (o: any) => replies.push(o),
          followUp: async () => {},
        };
        const ctx: any = {
          interaction,
          tr: Object.assign((k: string) => k, { lang: "tw" }),
          db,
        };
        await handleGachaView(ctx, interaction);
        return replies;
      };
      const ownerUser = { id: OWNER, toString: () => `<@${OWNER}>` };
      // 1) another user's raw key via `account:` is refused, no card
      let replies = await run("EF_555555", ownerUser);
      assert.equal(replies[replies.length - 1].content, "gacha_log_view_AccountNotOwned");
      assert.equal(replies[replies.length - 1].files, undefined);
      // 2) viewer asking for a key that is not theirs, with no user option
      replies = await run("EF_555555", null);
      assert.equal(replies[replies.length - 1].content, "gacha_log_view_AccountNotOwned");
      // 3) the owner's own UID through user: works
      replies = await run("EF_424242", ownerUser);
      assert.ok(replies[replies.length - 1].files?.length === 1, "own UID of the selected user renders");
      // 4) no account option: first owned UID that has data
      replies = await run(null, ownerUser);
      assert.ok(replies[replies.length - 1].files?.length === 1);
    }

    // --- more than 24 pools: the pool select pages, every pool stays reachable
    {
      const { db, ctx, replies } = await setup("羽冰");
      const log: any = buildLog("羽冰");
      log.characterList = Array.from({ length: 30 }, (_, i) => ({
        seqId: String(500 - i),
        charId: `chr_${i}`,
        charName: `Char ${i}`,
        rarity: 4,
        gachaTs: String(1_760_000_000_000 + (30 - i) * 86_400_000),
        poolId: `c_special_p${i}`,
        poolName: `特選尋訪 ${i}`,
        poolType: "E_CharacterGachaPoolType_Special",
        isFree: false,
      }));
      await db.set(LOG_KEY, log);
      for (let i = 0; i < 30; i++) {
        await db.set(`GACHA_POOL_METADATA_c_special_p${i}`, { data: { all: [] }, lastFetch: 0 });
      }
      const selectOptions = (reply: any) =>
        reply.components[0].toJSON().components[0].options as Array<{ value: string; label: string; default?: boolean }>;
      await showGachaStats(ctx, UID, "limited_char");
      let opts = selectOptions(replies[replies.length - 1]);
      assert.ok(opts.length <= 25);
      assert.equal(opts[0].value, "all");
      assert.equal(opts[opts.length - 1].value, "__pp:1", "last option pages to older pools");
      const shown = new Set(opts.map((o) => o.value));
      // selecting the paging option shows the next page, still as an overview
      await showGachaStats(ctx, UID, "limited_char", "__pp:1");
      opts = selectOptions(replies[replies.length - 1]);
      assert.equal(opts[0].value, "all");
      assert.equal(opts[0].default, true, "the overview stays selected");
      assert.equal(opts[opts.length - 1].value, "__pp:0", "last option pages back to newer pools");
      for (const o of opts) if (!o.value.startsWith("__pp:") && o.value !== "all") shown.add(o.value);
      assert.equal(
        [...shown].filter((v) => v.startsWith("c_special_p")).length,
        30,
        "all 30 pools are reachable through the two pages",
      );
      // an old pool selected from page 1 keeps that page of the select
      const oldest = opts.find((o) => o.value.startsWith("c_special_p"))!;
      await showGachaStats(ctx, UID, "limited_char", oldest.value);
      opts = selectOptions(replies[replies.length - 1]);
      assert.equal(opts.find((o) => o.default && o.value !== "all")?.value, oldest.value);
    }

    // --- pure helpers
    assert.equal(isGenericNickname(undefined, UID), true);
    assert.equal(isGenericNickname("Unknown", UID), true);
    assert.equal(isGenericNickname("424242", UID), true);
    assert.equal(isGenericNickname(UID, UID), true);
    assert.equal(isGenericNickname("羽冰", UID), false);
    const roles = [
      { uid: UID, rawUid: "424242", bindingUid: "b", nickname: "羽冰" },
    ];
    assert.equal(pickDisplayNickname("Unknown", UID, roles), "羽冰");
    assert.equal(pickDisplayNickname("Unknown", "EF_GUEST_1_2", []), "Guest");
    assert.equal(pickDisplayNickname("Unknown", UID, []), "Unknown");

    console.log("gacha view cache tests passed");
  } finally {
    canvasUtils.drawGachaStats = originalDraw;
  }
}

void main();
