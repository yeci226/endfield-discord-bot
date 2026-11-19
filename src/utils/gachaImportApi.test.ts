import assert from "node:assert/strict";
import axios from "axios";

import {
  GachaImportUrlError,
  fetchRawGachaFromUrl,
  pagePool,
  takeIncompleteFetches,
  validateGachaImportUrl,
} from "../features/gacha/gachaApi";
import { analyzeGachaImportFingerprint } from "../features/gacha/gachaFingerprint";
import { CustomDatabase } from "./Database";

const OFFICIAL = "https://ef-webview.gryphline.com/page/gacha_char";

function expectRefused(input: string, reason?: string) {
  const r = validateGachaImportUrl(input);
  assert.equal(r.ok, false, `must refuse: ${input}`);
  if (reason && !r.ok) assert.equal(r.reason, reason, input);
}

async function main() {
  // ---- Task 3: validateGachaImportUrl ----
  {
    const ok = validateGachaImportUrl(`${OFFICIAL}?token=abc&server_id=2&lang=zh-tw`);
    assert.equal(ok.ok, true);
    if (ok.ok && ok.kind === "url") {
      assert.equal(ok.apiBase, "https://ef-webview.gryphline.com");
      assert.equal(ok.token, "abc");
      assert.equal(ok.serverId, "2");
      assert.equal(ok.lang, "zh-tw");
    } else assert.fail("expected url target");

    const cn = validateGachaImportUrl(
      "https://EF-WEBVIEW.HYPERGRYPH.COM/x?u8_token=t&server=1",
    );
    assert.equal(cn.ok, true);
    if (cn.ok && cn.kind === "url")
      assert.equal(cn.apiBase, "https://ef-webview.hypergryph.com");

    const bare = validateGachaImportUrl("  part1%2Fx:part2  ");
    assert.deepEqual(bare, {
      ok: true,
      kind: "token",
      token: "part1/x",
      apiBase: null,
    });

    expectRefused("", "empty");
    expectRefused("   ", "empty");
    expectRefused(
      "https://ef-webview.gryphline.com.evil.com/x?token=a&server_id=2",
      "host_not_allowed",
    );
    expectRefused(
      "https://evil.com/ef-webview.gryphline.com?token=a&server_id=2",
      "host_not_allowed",
    );
    expectRefused(
      "https://ef-webview.gryphline.com@evil.com/x?token=a&server_id=2",
      "userinfo",
    );
    expectRefused(
      "https://ef-webview.gryphline.com:pw@ef-webview.gryphline.com/x?token=a&server_id=2",
      "userinfo",
    );
    expectRefused(
      "https://user@ef-webview.gryphline.com/x?token=a&server_id=2",
      "userinfo",
    );
    expectRefused(
      "http://ef-webview.gryphline.com/x?token=a&server_id=2",
      "not_https",
    );
    expectRefused("ftp://ef-webview.gryphline.com/x?token=a&server_id=2", "not_https");
    expectRefused("https://1.2.3.4/x?token=a&server_id=2", "host_not_allowed");
    expectRefused("https://[::1]/x?token=a&server_id=2", "host_not_allowed");
    expectRefused(
      "https://ef-webview.gryphline.com:8443/x?token=a&server_id=2",
      "port",
    );
    expectRefused(
      "https://ef-webview.gryphline.com./x?token=a&server_id=2",
      "host_not_allowed",
    );
    expectRefused("https://ef-webview.gryphline.com/x?server_id=2", "missing_params");
    expectRefused("https://ef-webview.gryphline.com/x?token=a", "missing_params");
    expectRefused(
      "https://ef-webview.gryphline.com/x?token=a&server_id=../../x",
      "bad_server",
    );
    expectRefused("https://", "invalid_url");
  }

  // ---- refused input makes zero requests (also via the fingerprint path) ----
  const originalGet = axios.get;
  const originalPost = axios.post;
  const calls: Array<{ url: string; config: any }> = [];
  axios.get = (async (url: string, config: any) => {
    calls.push({ url, config });
    throw new Error("network must not be reached");
  }) as any;
  axios.post = (async (url: string, _body: any, config: any) => {
    calls.push({ url, config });
    throw new Error("network must not be reached");
  }) as any;
  try {
    const evil = "https://ef-webview.gryphline.com.evil.com/x?token=a&server_id=2";
    await assert.rejects(
      () => fetchRawGachaFromUrl(evil),
      (e: any) => e instanceof GachaImportUrlError && e.reason === "host_not_allowed",
    );
    const db = new CustomDatabase(":memory:");
    await assert.rejects(
      () => analyzeGachaImportFingerprint(db, evil, ["EF_1"], "EF_1"),
      (e: any) => e instanceof GachaImportUrlError,
    );
    await assert.rejects(() => fetchRawGachaFromUrl("http://ef-webview.gryphline.com/x?token=a&server_id=2"));
    assert.equal(calls.length, 0, "no request for refused input");

    // ---- Task 4: timeouts, no redirects, honest partial imports ----
    const pages: Record<string, any> = {};
    const record = (seq: string, extra: any = {}) => ({
      seqId: seq,
      gachaTs: seq,
      rarity: 4,
      poolId: "p",
      poolName: "P",
      charId: `c${seq}`,
      charName: `C${seq}`,
      ...extra,
    });
    let weaponMode: "ok" | "midcode" | "listfail" | "auth" = "ok";
    axios.get = (async (url: string, config: any) => {
      calls.push({ url, config });
      const p = config?.params ?? {};
      if (url.endsWith("/api/record/char")) {
        if (p.pool_type === "E_CharacterGachaPoolType_Special" && !p.seq_id)
          return { data: { code: 0, data: { list: [record("30"), record("29")], hasMore: true } } };
        if (p.pool_type === "E_CharacterGachaPoolType_Special")
          return { data: { code: 0, data: { list: [record("28")], hasMore: false } } };
        return { data: { code: 0, data: { list: [], hasMore: false } } };
      }
      if (url.endsWith("/api/record/weapon/pool")) {
        if (weaponMode === "listfail") return { data: { code: 500, msg: "boom" } };
        if (weaponMode === "auth") return { data: { code: 40100, msg: "expired" } };
        return { data: { code: 0, data: [{ poolId: "w1", poolName: "W1" }, { poolId: "w2", poolName: "W2" }] } };
      }
      if (url.endsWith("/api/record/weapon")) {
        if (p.pool_id === "w2" && weaponMode === "midcode") {
          if (!p.seq_id)
            return { data: { code: 0, data: { list: [record("20", { weaponId: "x" })], hasMore: true } } };
          return { data: { code: 7, msg: "mid-pool failure" } };
        }
        return { data: { code: 0, data: { list: [record("10")], hasMore: false } } };
      }
      throw new Error(`unexpected ${url}`);
    }) as any;

    const url = `${OFFICIAL}?token=tok&server_id=2`;
    const progress = () => undefined;
    let raw = await fetchRawGachaFromUrl(url, progress);
    assert.deepEqual(raw.incomplete, []);
    assert.equal(raw.characterList.length, 3);
    assert.equal(raw.weaponList.length, 2);
    assert.equal(raw.apiDomain, "https://ef-webview.gryphline.com");
    assert.equal(raw.inferredUid, "EF_2");
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.equal(c.config.timeout, 15000, `timeout on ${c.url}`);
      assert.equal(c.config.maxRedirects, 0, `no redirects on ${c.url}`);
    }
    assert.deepEqual(takeIncompleteFetches(progress), []);

    weaponMode = "midcode";
    const progress2 = () => undefined;
    raw = await fetchRawGachaFromUrl(url, progress2);
    assert.equal(raw.incomplete.length, 1);
    assert.equal(raw.incomplete[0].poolType, "WeaponPool");
    assert.equal(raw.incomplete[0].poolId, "w2");
    assert.match(raw.incomplete[0].reason, /code 7/);
    // the page read before the failure is kept
    assert.equal(raw.weaponList.length, 2);
    assert.deepEqual(takeIncompleteFetches(progress2), raw.incomplete);
    assert.deepEqual(takeIncompleteFetches(progress2), [], "taken once");

    weaponMode = "listfail";
    raw = await fetchRawGachaFromUrl(url);
    assert.equal(raw.incomplete.length, 1);
    assert.match(raw.incomplete[0].reason, /pool list/);
    assert.equal(raw.weaponList.length, 0);

    weaponMode = "auth";
    await assert.rejects(
      () => fetchRawGachaFromUrl(url),
      (e: any) => e.apiCode === 40100,
    );

    // one character pool timing out is partial, every one failing is a failure
    weaponMode = "ok";
    const goodGet = axios.get;
    axios.get = (async (u: string, config: any) => {
      if (config?.params?.pool_type === "E_CharacterGachaPoolType_Joint")
        throw Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" });
      return (goodGet as any)(u, config);
    }) as any;
    raw = await fetchRawGachaFromUrl(url);
    assert.deepEqual(
      raw.incomplete.map((i) => [i.poolType, i.reason]),
      [["E_CharacterGachaPoolType_Joint", "timeout"]],
    );
    axios.get = (async (u: string, config: any) => {
      if (u.endsWith("/api/record/char")) throw new Error("down");
      return (goodGet as any)(u, config);
    }) as any;
    await assert.rejects(() => fetchRawGachaFromUrl(url), /down/);
    axios.get = goodGet;

    // ---- Task 5: stopAt ----
    calls.length = 0;
    const seen: string[] = [];
    raw = await fetchRawGachaFromUrl(url, undefined, undefined, {
      stopAt: {
        character: (seq) => {
          seen.push(seq);
          return seq === "29";
        },
      },
    });
    // page 1 (30, 29) is kept whole, page 2 is never requested
    assert.deepEqual(
      raw.characterList.map((r) => r.seqId),
      ["30", "29"],
    );
    assert.deepEqual(seen, ["30", "29"]);
    assert.equal(
      calls.filter(
        (c) =>
          c.config?.params?.pool_type === "E_CharacterGachaPoolType_Special",
      ).length,
      1,
    );
    // default = today's behaviour: everything
    raw = await fetchRawGachaFromUrl(url);
    assert.deepEqual(
      raw.characterList.map((r) => r.seqId),
      ["30", "29", "28"],
    );
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }

  // pagePool with a fake page source
  {
    const source: GachaRecordLike[][] = [
      [{ seqId: "9" }, { seqId: "8" }],
      [{ seqId: "7" }, { seqId: "6" }],
      [{ seqId: "5" }],
    ];
    const asked: Array<string | undefined> = [];
    const fetchPage = async (last: string | undefined, page: number) => {
      asked.push(last);
      return { list: source[page - 1] as any, hasMore: page < source.length };
    };
    const tag = (r: any) => (r.tagged = true);
    let out: any[] = [];
    await pagePool(fetchPage, out, { tag, delayMs: 0 });
    assert.deepEqual(out.map((r) => r.seqId), ["9", "8", "7", "6", "5"]);
    assert.ok(out.every((r) => r.tagged));
    assert.deepEqual(asked, [undefined, "8", "6"]);

    out = [];
    asked.length = 0;
    await pagePool(fetchPage, out, { tag, delayMs: 0, stop: (s) => s === "7" });
    assert.deepEqual(out.map((r) => r.seqId), ["9", "8", "7", "6"]);
    assert.equal(asked.length, 2);

    // nothing known: all pages
    out = [];
    await pagePool(fetchPage, out, { tag, delayMs: 0, stop: () => false });
    assert.equal(out.length, 5);

    // failure on page 2 keeps page 1 in `out`
    out = [];
    await assert.rejects(() =>
      pagePool(
        async (_l, page) => {
          if (page === 2) throw new Error("page 2");
          return { list: [{ seqId: "1" } as any], hasMore: true };
        },
        out,
        { tag, delayMs: 0 },
      ),
    );
    assert.equal(out.length, 1);
  }

  console.log("gacha import api tests passed");
}

type GachaRecordLike = { seqId: string };

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
