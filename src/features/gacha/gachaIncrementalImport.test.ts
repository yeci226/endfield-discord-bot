import assert from "node:assert/strict";
import axios from "axios";
import { CustomDatabase } from "../../utils/Database";
import {
  clearGachaLog,
  commitFetchedGachaLog,
  decideStopAt,
  detectPityGaps,
  fetchAndMergeGachaLog,
  fetchAndMergeGachaLogFromAccount,
  migrateGachaLog,
  recordsForGapDetection,
} from "./gachaStore";
import { fetchRawGachaFromUrl, IncompleteFetch } from "./gachaApi";
import { GachaLogData, GachaRecord } from "./gachaTypes";

const URL1 =
  "https://ef-webview.gryphline.com/page/gacha_char?token=t&server_id=2&lang=en-us";
const SPECIAL = "E_CharacterGachaPoolType_Special";
const STANDARD = "E_CharacterGachaPoolType_Standard";
const JOINT = "E_CharacterGachaPoolType_Joint";
const PAGE_SIZE = 5;

function rec(seq: number, over: Partial<GachaRecord> = {}): GachaRecord {
  return {
    seqId: String(seq),
    gachaTs: String(1700000000000 + seq * 1000),
    poolId: "p_" + (over.poolType ?? SPECIAL),
    poolName: "Pool",
    poolType: SPECIAL,
    isFree: false,
    rarity: 4,
    charId: "chr_x",
    charName: "X",
    kind: "draw",
    ...over,
  };
}

// ------------------------------------------------------- fake page source ---

class FakeSource {
  char: Record<string, GachaRecord[]> = {
    [STANDARD]: [],
    [SPECIAL]: [],
    [JOINT]: [],
    E_CharacterGachaPoolType_Rerun: [],
    E_CharacterGachaPoolType_Beginner: [],
  };
  weapon: Record<string, GachaRecord[]> = { w1: [], w2: [] };
  seq = 1;
  requests = { char: 0, weapon: 0, weaponPool: 0 };
  failCharAfterFirstPage: string | null = null;
  failWeaponPoolList = false;
  /** seqIds of the records handed out (newest first within a page). */
  addChar(type: string, n: number) {
    for (let i = 0; i < n; i++)
      this.char[type].unshift(
        rec(this.seq++, { poolType: type, poolId: "p_" + type, rarity: i % 9 === 0 ? 6 : 4 }),
      );
  }
  addWeapon(pool: string, n: number) {
    for (let i = 0; i < n; i++)
      this.weapon[pool].unshift(
        rec(this.seq++, {
          poolType: "WeaponPool",
          poolId: pool,
          weaponId: "wpn_" + pool,
          weaponName: "W",
          charId: undefined,
          charName: undefined,
        }),
      );
  }
  get total() {
    return this.requests.char + this.requests.weapon + this.requests.weaponPool;
  }
  reset() {
    this.requests = { char: 0, weapon: 0, weaponPool: 0 };
  }
  page(list: GachaRecord[], cursor?: string) {
    // The API hands out clones; the importer tags them in place.
    const rest = cursor ? list.filter((r) => Number(r.seqId) < Number(cursor)) : list;
    const slice = rest.slice(0, PAGE_SIZE).map((r) => ({ ...r }));
    return { data: { code: 0, data: { list: slice, hasMore: rest.length > PAGE_SIZE } } };
  }
  install() {
    axios.get = (async (url: string, config: any) => {
      const p = config?.params ?? {};
      if (url.endsWith("/api/record/char")) {
        this.requests.char++;
        if (this.failCharAfterFirstPage === p.pool_type && p.seq_id)
          return { data: { code: 7, msg: "boom" } };
        return this.page(this.char[p.pool_type] ?? [], p.seq_id);
      }
      if (url.endsWith("/api/record/weapon/pool")) {
        this.requests.weaponPool++;
        if (this.failWeaponPoolList) return { data: { code: 500, msg: "down" } };
        return {
          data: {
            code: 0,
            data: Object.keys(this.weapon).map((id) => ({ poolId: id, poolName: id })),
          },
        };
      }
      if (url.endsWith("/api/record/weapon")) {
        this.requests.weapon++;
        return this.page(this.weapon[p.pool_id] ?? [], p.seq_id);
      }
      if (url.includes("/api/content")) return { data: { code: 1 } };
      throw new Error(`unexpected request ${url}`);
    }) as typeof axios.get;
  }
}

function seeded(): FakeSource {
  const s = new FakeSource();
  // seqIds interleave across pool types and the two weapon pools.
  for (let round = 0; round < 6; round++) {
    s.addChar(SPECIAL, 5);
    s.addChar(STANDARD, 3);
    s.addChar(JOINT, 2);
    s.addWeapon("w1", 2);
    s.addWeapon("w2", 1);
  }
  return s;
}

/** The parts of a stored log that must match between two import strategies. */
function comparable(log: GachaLogData) {
  const { export_timestamp, updatedAt, ...info } = log.info;
  void export_timestamp;
  void updatedAt;
  return { characterList: log.characterList, weaponList: log.weaponList, info };
}

async function importOnce(db: CustomDatabase, uid: string, forceFull = false) {
  return fetchAndMergeGachaLog(
    db,
    URL1,
    undefined,
    uid,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { forceFull },
  );
}

// ------------------------------------------------------------ Task 4 tests ---

async function testIncrementalEqualsFull() {
  const scenarios: Array<{ name: string; add: (s: FakeSource) => void }> = [
    {
      name: "new records spanning more than one page",
      add: (s) => {
        s.addChar(SPECIAL, 12); // 3 pages
        s.addChar(STANDARD, 3);
        s.addWeapon("w1", 7);
      },
    },
    { name: "zero new records", add: () => undefined },
    {
      name: "a brand-new weapon pool appears",
      add: (s) => {
        s.weapon.w3 = [];
        s.addWeapon("w3", 6);
        s.addChar(JOINT, 1);
      },
    },
  ];
  for (const sc of scenarios) {
    const source = seeded();
    source.install();
    const inc = new CustomDatabase(":memory:");
    const full = new CustomDatabase(":memory:");
    try {
      // Same first import (always a full fetch) into both.
      await importOnce(inc, "u");
      await importOnce(full, "u");
      const firstLog = (await inc.get<GachaLogData>("GACHA_LOG_u"))!;
      assert.equal(firstLog.info.charFetchComplete, true);
      assert.equal(firstLog.info.weaponFetchComplete, true);

      sc.add(source);

      source.reset();
      const rInc = await importOnce(inc, "u");
      const incRequests = { ...source.requests, total: source.total };
      source.reset();
      const rFull = await importOnce(full, "u", true);
      const fullRequests = { ...source.requests, total: source.total };

      assert.deepEqual(
        comparable((await inc.get<GachaLogData>("GACHA_LOG_u"))!),
        comparable((await full.get<GachaLogData>("GACHA_LOG_u"))!),
        `${sc.name}: incremental result equals the full fetch`,
      );
      assert.equal(rInc.hasDataGap, rFull.hasDataGap, sc.name);
      assert.equal(rInc.totalChar, rFull.totalChar, sc.name);
      assert.deepEqual(rInc.incomplete, []);
      assert.deepEqual(rInc.incremental, { character: true, weapon: true });
      assert.deepEqual(rFull.incremental, { character: false, weapon: false });
      assert.ok(
        incRequests.total < fullRequests.total,
        `${sc.name}: paging stopped early (${incRequests.total} < ${fullRequests.total})`,
      );
      if (sc.name === "zero new records") {
        // one page per character type, the weapon pool list, one page per weapon pool
        assert.equal(incRequests.char, 5);
        assert.equal(incRequests.weaponPool, 1);
        assert.equal(incRequests.weapon, 2);
      }
    } finally {
      inc.close();
      full.close();
    }
  }
}

async function testFullFetchWhenNotAllowed() {
  const source = seeded();
  source.install();
  const base = async () => {
    const db = new CustomDatabase(":memory:");
    await importOnce(db, "u");
    return db;
  };
  source.reset();
  const dbFull = new CustomDatabase(":memory:");
  await importOnce(dbFull, "ref", true);
  const fullTotal = source.total;
  dbFull.close();

  const cases: Array<{ name: string; mutate: (info: GachaLogData["info"]) => void; locale?: string }> = [
    { name: "legacy log without the flag", mutate: (i) => { delete i.charFetchComplete; delete i.weaponFetchComplete; } },
    { name: "flag false", mutate: (i) => { i.charFetchComplete = false; i.weaponFetchComplete = false; } },
    { name: "pending pity marker", mutate: (i) => { i.charPityResetSeqId = "5"; i.weaponPityResetSeqId = "5"; } },
  ];
  for (const c of cases) {
    const db = await base();
    const log = (await db.get<GachaLogData>("GACHA_LOG_u"))!;
    c.mutate(log.info);
    await db.set("GACHA_LOG_u", log);
    source.reset();
    const r = await importOnce(db, "u");
    assert.deepEqual(r.incremental, { character: false, weapon: false }, c.name);
    assert.equal(source.total, fullTotal, `${c.name}: same requests as a full fetch`);
    db.close();
  }

  // Language changed: the predicates are ignored by the importer.
  {
    const db = await base();
    source.reset();
    const r = await fetchAndMergeGachaLog(db, URL1.replace("en-us", "ja-jp"), undefined, "u");
    assert.deepEqual(r.incremental, { character: false, weapon: false }, "language changed");
    assert.equal(source.total, fullTotal);
    db.close();
  }

  // Without a known target UID nothing is incremental.
  {
    const db = await base();
    await importOnce(db, "EF_2"); // stored under the inferred uid too
    source.reset();
    const r = await fetchAndMergeGachaLog(db, URL1);
    assert.deepEqual(r.incremental, { character: false, weapon: false }, "no target uid");
    assert.equal(source.total, fullTotal);
    db.close();
  }

  // A ranged clear and a guest migration both force the next import to be full.
  {
    const db = await base();
    await clearGachaLog(db, "u", "2023-11-14T22:14:00.000Z", "2023-11-14T22:14:30.000Z");
    const log = (await db.get<GachaLogData>("GACHA_LOG_u"))!;
    assert.equal(log.info.charFetchComplete, false);
    assert.equal(log.info.weaponFetchComplete, false);
    source.reset();
    const r = await importOnce(db, "u");
    assert.deepEqual(r.incremental, { character: false, weapon: false });
    // the cut-out range is back, as a full fetch restores it
    assert.equal(
      (await db.get<GachaLogData>("GACHA_LOG_u"))!.characterList.length,
      Object.values(source.char).reduce((n, l) => n + l.length, 0),
    );
    assert.equal((await db.get<GachaLogData>("GACHA_LOG_u"))!.info.charFetchComplete, true);
    db.close();
  }
  {
    const db = await base();
    await db.set("GACHA_LOG_EF_GUEST_1_a", {
      characterList: [rec(1000)],
      weaponList: [],
      info: { uid: "EF_GUEST_1_a", lang: "en-us", export_timestamp: 1 },
    });
    await migrateGachaLog(db, "EF_GUEST_1_a", "u");
    const log = (await db.get<GachaLogData>("GACHA_LOG_u"))!;
    assert.equal(log.info.charFetchComplete, false);
    assert.equal(log.info.weaponFetchComplete, false);
    db.close();
  }

  // forceFull is honoured even when everything else allows incremental.
  {
    const db = await base();
    source.reset();
    const r = await importOnce(db, "u", true);
    assert.deepEqual(r.incremental, { character: false, weapon: false });
    assert.equal(source.total, fullTotal);
    db.close();
  }
}

function testDecideStopAt() {
  const log = (info: Partial<GachaLogData["info"]>): GachaLogData => ({
    characterList: [rec(10), rec(5)],
    weaponList: [],
    info: { uid: "u", lang: "en-us", export_timestamp: 1, ...info },
  });
  assert.equal(decideStopAt(null), undefined);
  assert.equal(decideStopAt(log({})), undefined, "legacy log: no flag");
  const ok = decideStopAt(log({ charFetchComplete: true }))!;
  assert.equal(ok.lang, "en-us");
  assert.ok(ok.character!("10"));
  assert.ok(ok.character!("5"));
  assert.ok(!ok.character!("11"), "matched by stored seqId, not by order");
  assert.equal(ok.weapon, undefined, "empty weapon list: nothing to stop at");
  assert.equal(
    decideStopAt(log({ charFetchComplete: true, charPityResetSeqId: "5" })),
    undefined,
  );
  assert.equal(decideStopAt(log({ charFetchComplete: true }), { forceFull: true }), undefined);
}

// ------------------------------------------------------------ Task 3 tests ---

function testGapDetectionSkipsIncompletePools() {
  const existing = {
    characterList: [rec(100, { poolType: SPECIAL }), rec(95, { poolType: STANDARD })],
    weaponList: [rec(50, { poolType: "WeaponPool", poolId: "w1" })],
  };
  // Special came back truncated (only its newest page); Standard is empty.
  const truncated: IncompleteFetch[] = [{ poolType: SPECIAL, reason: "code 7" }];
  const fetchedTruncated = {
    characterList: [rec(150, { poolType: SPECIAL }), rec(140, { poolType: SPECIAL })],
    weaponList: [] as GachaRecord[],
  };
  assert.equal(
    detectPityGaps(existing, fetchedTruncated).charPityResetSeqId,
    "140",
    "without the incomplete note the truncated page looks like a gap",
  );
  assert.equal(
    detectPityGaps(existing, fetchedTruncated, truncated).charPityResetSeqId,
    undefined,
    "a truncated pool creates no marker",
  );

  // A complete pool next to the truncated one still yields its real gap.
  const fetchedBoth = {
    characterList: [
      ...fetchedTruncated.characterList,
      rec(120, { poolType: STANDARD }),
      rec(110, { poolType: STANDARD }),
    ],
    weaponList: [] as GachaRecord[],
  };
  assert.equal(detectPityGaps(existing, fetchedBoth, truncated).charPityResetSeqId, "110");

  // Weapon pool list failed: nothing about weapons can be trusted.
  const listFailed: IncompleteFetch[] = [{ poolType: "WeaponPool", reason: "pool list: code 500" }];
  const fetchedWeapons = {
    characterList: [] as GachaRecord[],
    weaponList: [rec(300, { poolType: "WeaponPool", poolId: "w1" })],
  };
  assert.equal(detectPityGaps(existing, fetchedWeapons).weaponPityResetSeqId, "300");
  assert.equal(detectPityGaps(existing, fetchedWeapons, listFailed).weaponPityResetSeqId, undefined);
  // One weapon pool truncated, another complete.
  const onePool: IncompleteFetch[] = [{ poolType: "WeaponPool", poolId: "w1", reason: "code 7" }];
  assert.deepEqual(
    recordsForGapDetection(
      [rec(1, { poolId: "w1" }), rec(2, { poolId: "w2" })],
      onePool,
      "weapon",
    ).map((r) => r.poolId),
    ["w2"],
  );
}

async function testTruncatedImportKeepsNoFalseMarker() {
  const db = new CustomDatabase(":memory:");
  const source = new FakeSource();
  source.install();
  try {
    source.addChar(SPECIAL, 8);
    await importOnce(db, "u");
    // New pulls arrive, but the next fetch of Special fails after its first page.
    source.addChar(SPECIAL, 30);
    source.failCharAfterFirstPage = SPECIAL;
    const r = await importOnce(db, "u");
    assert.equal(r.incomplete.length, 1);
    assert.equal(r.incomplete[0].poolType, SPECIAL);
    assert.equal(r.hasDataGap, false, "no false gap from the truncated pool");
    const log = (await db.get<GachaLogData>("GACHA_LOG_u"))!;
    assert.equal(log.info.charPityResetSeqId, undefined);
    assert.equal(log.info.charFetchComplete, false, "an incomplete import is not recorded as complete");

    // The next import must therefore page everything, and closes the flag.
    source.failCharAfterFirstPage = null;
    source.reset();
    const r2 = await importOnce(db, "u");
    assert.deepEqual(r2.incremental, { character: false, weapon: false });
    assert.equal(r2.incomplete.length, 0);
    const log2 = (await db.get<GachaLogData>("GACHA_LOG_u"))!;
    assert.equal(log2.info.charFetchComplete, true);
    assert.equal(log2.characterList.length, 38);

    // A failed weapon pool list clears only the weapon flag.
    source.failWeaponPoolList = true;
    await importOnce(db, "u");
    const log3 = (await db.get<GachaLogData>("GACHA_LOG_u"))!;
    assert.equal(log3.info.weaponFetchComplete, false);
    assert.equal(log3.info.charFetchComplete, true);
  } finally {
    db.close();
  }
}

async function testStopAtLanguageGuard() {
  const source = seeded();
  source.install();
  const known = (id: string) => true;
  source.reset();
  const raw = await fetchRawGachaFromUrl(URL1, undefined, undefined, {
    stopAt: { character: known, weapon: known, lang: "zh-tw" },
  });
  assert.deepEqual(raw.incremental, { character: false, weapon: false });
  const total = source.total;
  source.reset();
  const raw2 = await fetchRawGachaFromUrl(URL1, undefined, undefined, {
    stopAt: { character: known, weapon: known, lang: "en-us" },
  });
  assert.deepEqual(raw2.incremental, { character: true, weapon: true });
  assert.ok(source.total < total);
}

async function testProbeAndIncompletePassThrough() {
  const db = new CustomDatabase(":memory:");
  const source = seeded();
  source.install();
  const configs: Array<{ url: string; config: any }> = [];
  const inner = axios.get;
  axios.get = (async (url: string, config: any) => {
    configs.push({ url, config });
    return (inner as any)(url, config);
  }) as typeof axios.get;
  const originalPost = axios.post;
  axios.post = (async (url: string) => {
    if (url.includes("/user/oauth2/v2/grant"))
      return { data: { status: 0, data: { token: "oauth" } } };
    return { data: { status: 0, data: { token: "u8" } } };
  }) as typeof axios.post;
  try {
    source.failCharAfterFirstPage = SPECIAL;
    const result = await fetchAndMergeGachaLogFromAccount(
      db,
      "ACCOUNT_TOKEN=abc",
      "12345",
      "gryphline",
      "u",
    );
    assert.equal(result.incomplete.length, 1, "incomplete[] travels with the result");
    assert.equal(result.incomplete[0].poolType, SPECIAL);
    const probe = configs.find((c) => c.config.params?.server_id === "3");
    assert.ok(probe, "the store probed the server");
    assert.equal(probe!.config.timeout, 15000);
    assert.equal(probe!.config.maxRedirects, 0);
    for (const c of configs) {
      if (c.url.includes("/api/record/"))
        assert.equal(c.config.timeout, 15000, c.url);
    }
  } finally {
    axios.get = inner;
    axios.post = originalPost;
    db.close();
  }
}

async function main() {
  const originalGet = axios.get;
  try {
    testDecideStopAt();
    testGapDetectionSkipsIncompletePools();
    await testIncrementalEqualsFull();
    await testFullFetchWhenNotAllowed();
    await testTruncatedImportKeepsNoFalseMarker();
    await testStopAtLanguageGuard();
    await testProbeAndIncompletePassThrough();
    void commitFetchedGachaLog;
    console.log("Gacha incremental import tests passed");
  } finally {
    axios.get = originalGet;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
