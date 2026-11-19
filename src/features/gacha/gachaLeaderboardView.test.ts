import assert from "node:assert/strict";
import {
  LEADERBOARD_PAGE_SIZE,
  buildLeaderboardView,
  leaderboardCustomId,
  parseLeaderboardCustomId,
  sixStarRate,
} from "./gachaLeaderboard";
import { GachaLeaderboardEntry } from "./gachaTypes";

function entry(
  uid: string,
  total: number,
  six: number,
  guilds: string[] = [],
): GachaLeaderboardEntry {
  return {
    uid,
    nickname: uid,
    displayName: `name-${uid}`,
    lastUpdate: 0,
    total,
    nonFreeTotal: total,
    freeTotal: 0,
    guilds,
    stats: {
      TOTAL: {
        total,
        sixStarCount: six,
        fiveStarCount: 0,
        probability: sixStarRate(six, total),
      },
    },
  };
}

/** 25 players; uid "p01" has the most pulls, "p25" the fewest. */
function board(guildFor: (i: number) => string[] = () => []) {
  return Array.from({ length: 25 }, (_, i) =>
    entry(`p${String(i + 1).padStart(2, "0")}`, 1000 - i * 10, 10 + (i % 7), guildFor(i)),
  );
}

function testPaging() {
  const entries = board();
  const base = { poolId: "TOTAL", sortType: "pulls" as const };
  const p0 = buildLeaderboardView(entries, { ...base, page: 0 });
  assert.equal(LEADERBOARD_PAGE_SIZE, 10);
  assert.equal(p0.pageCount, 3);
  assert.equal(p0.rankedCount, 25);
  assert.deepEqual(p0.rows.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const p1 = buildLeaderboardView(entries, { ...base, page: 1 });
  assert.deepEqual(p1.rows.map((r) => r.rank), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const p2 = buildLeaderboardView(entries, { ...base, page: 2 });
  assert.equal(p2.rows.length, 5);
  assert.equal(buildLeaderboardView(entries, { ...base, page: 99 }).page, 2, "clamped high");
  assert.equal(buildLeaderboardView(entries, { ...base, page: -4 }).page, 0, "clamped low");
  assert.equal(buildLeaderboardView(entries, { ...base, page: NaN as any }).page, 0);
  // an empty board still has one (empty) page
  const none = buildLeaderboardView([], base);
  assert.equal(none.pageCount, 1);
  assert.equal(none.rows.length, 0);
  assert.equal(none.totalPlayers, 0);
}

function testMyRank() {
  const entries = board();
  const base = { poolId: "TOTAL", sortType: "pulls" as const };
  // on the shown page: highlighted there, not repeated beneath
  const onPage = buildLeaderboardView(entries, { ...base, page: 0, myUids: ["p03"] });
  assert.equal(onPage.myRows.length, 1);
  assert.equal(onPage.myOutside.length, 0);
  assert.equal(onPage.myPage, 0);
  // off the page: shown beneath, and the jump target is the page that holds it
  const off = buildLeaderboardView(entries, { ...base, page: 0, myUids: ["p23"] });
  assert.deepEqual(off.myOutside.map((r) => r.rank), [23]);
  assert.equal(off.myPage, 2);
  // two accounts: the best one decides the jump page
  const two = buildLeaderboardView(entries, { ...base, page: 2, myUids: ["p24", "p12"] });
  assert.equal(two.myPage, 1);
  assert.deepEqual(two.myOutside.map((r) => r.rank), [12], "the page holds rank 24, not 12");
  // not on the board at all
  const nobody = buildLeaderboardView(entries, { ...base, myUids: ["ghost"] });
  assert.equal(nobody.myPage, null);
  assert.equal(nobody.myRows.length, 0);
}

function testUnrankedInvoker() {
  const entries = [...board(), entry("newbie", 60, 1)];
  const luck = buildLeaderboardView(entries, {
    poolId: "TOTAL",
    sortType: "luck",
    myUids: ["newbie"],
  });
  assert.equal(luck.myRows.length, 0, "60 pulls is below the luck minimum");
  assert.equal(luck.myUnranked.length, 1);
  assert.equal(luck.myUnranked[0].stat.total, 60);
  assert.equal(luck.myPage, null);
  assert.equal(luck.rankedCount, 25);
  const pulls = buildLeaderboardView(entries, {
    poolId: "TOTAL",
    sortType: "pulls",
    myUids: ["newbie"],
  });
  assert.equal(pulls.myUnranked.length, 0);
  assert.equal(pulls.myRows[0].rank, 26);
}

function testScope() {
  const entries = board((i) => (i < 4 ? ["g1"] : i < 6 ? ["g1", "g2"] : []));
  const base = { poolId: "TOTAL", sortType: "pulls" as const };
  const global = buildLeaderboardView(entries, { ...base, scope: "global", guildId: "g1" });
  assert.equal(global.scope, "global");
  assert.equal(global.totalPlayers, 25);

  const g1 = buildLeaderboardView(entries, { ...base, scope: "guild", guildId: "g1" });
  assert.equal(g1.scope, "guild");
  assert.equal(g1.rankedCount, 6);
  assert.deepEqual(g1.rows.map((r) => r.entry.uid), ["p01", "p02", "p03", "p04", "p05", "p06"]);
  assert.deepEqual(g1.rows.map((r) => r.rank), [1, 2, 3, 4, 5, 6], "ranks restart inside the server");
  assert.equal(g1.totalPlayers, 6);
  assert.equal(g1.scopeEmpty, false);

  const g2 = buildLeaderboardView(entries, { ...base, scope: "guild", guildId: "g2" });
  assert.equal(g2.rankedCount, 2);

  // nobody there yet: flagged so the card can say how the list fills
  const empty = buildLeaderboardView(entries, { ...base, scope: "guild", guildId: "g-new" });
  assert.equal(empty.scopeEmpty, true);
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.pageCount, 1);

  // DM: the server scope does not exist, it falls back to global
  const dm = buildLeaderboardView(entries, { ...base, scope: "guild", guildId: null });
  assert.equal(dm.scope, "global");
  assert.equal(dm.rankedCount, 25);
  // rows migrated from the blob have no guilds at all
  const legacy = entries.map((e) => ({ ...e, guilds: undefined }));
  assert.equal(
    buildLeaderboardView(legacy, { ...base, scope: "guild", guildId: "g1" }).scopeEmpty,
    true,
  );
}

function testHeaderNumbers() {
  const entries = [entry("a", 100, 2), entry("b", 300, 4), entry("c", 50, 1, ["g"])];
  const v = buildLeaderboardView(entries, { poolId: "TOTAL", sortType: "pulls" });
  assert.equal(v.totalPlayers, 3);
  assert.equal(v.totalPulls, 450);
  assert.equal(v.avgRate, 7 / 450);
  const g = buildLeaderboardView(entries, { poolId: "TOTAL", sortType: "pulls", scope: "guild", guildId: "g" });
  assert.equal(g.totalPulls, 50, "header numbers follow the scope");
}

function testCustomIds() {
  const id = leaderboardCustomId("lb_page", {
    poolId: "special_1_0_1",
    sortType: "luck",
    scope: "guild",
    page: 3,
  });
  assert.equal(id, "gacha:lb_page:special_1_0_1:luck:guild:3");
  assert.ok(id.length <= 100);
  assert.deepEqual(parseLeaderboardCustomId(id), {
    action: "lb_page",
    poolId: "special_1_0_1",
    sortType: "luck",
    scope: "guild",
    page: 3,
  });
  // ids from messages sent before this change have no scope/page
  assert.deepEqual(parseLeaderboardCustomId("gacha:lb_sort:TOTAL:pulls"), {
    action: "lb_sort",
    poolId: "TOTAL",
    sortType: "pulls",
    scope: "global",
    page: 0,
  });
  // junk never throws or escapes the allowed values
  const junk = parseLeaderboardCustomId("gacha:lb_page:TOTAL:evil:planet:-7")!;
  assert.equal(junk.sortType, "luck");
  assert.equal(junk.scope, "global");
  assert.equal(junk.page, 0);
  assert.equal(parseLeaderboardCustomId("gacha:log_page:x"), null);
  assert.equal(parseLeaderboardCustomId("nonsense"), null);
}

testPaging();
testMyRank();
testUnrankedInvoker();
testScope();
testHeaderNumbers();
testCustomIds();
console.log("Gacha leaderboard view tests passed");
