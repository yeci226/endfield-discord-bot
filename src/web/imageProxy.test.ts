import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evictCache,
  extensionForContentType,
  fetchProxiedImage,
  findCached,
  isServableCacheFile,
  RawRequest,
  validateProxyUrl,
  writeCached,
} from "./imageProxy";

const ok = (u: string) => assert.equal(validateProxyUrl(u).ok, true, u);
const bad = (u: unknown) =>
  assert.equal(validateProxyUrl(u).ok, false, String(u));

ok("https://bbs.hycdn.cn/image/a.png");
ok("https://skport.com/x.png");
ok("https://static.skport.com/x.png");
ok("https://cdn.discordapp.com/avatars/1/a.png?size=128");
ok("https://media.discordapp.net/a.png");
ok("https://ef-webview.gryphline.com/a.png");
ok("https://SKPORT.COM/a.png");
bad("http://skport.com/a.png");
bad("https://localhost/a.png");
bad("https://127.0.0.1/a.png");
bad("https://[::1]/a.png");
bad("https://10.0.0.1/a.png");
bad("https://169.254.169.254/latest");
bad("https://skport.com@evil.com/a.png");
bad("https://user:pw@skport.com/a.png");
bad("https://evil-skport.com/a.png");
bad("https://skport.com.evil.com/a.png");
bad("https://skport.com:8443/a.png");
bad("file:///etc/passwd");
bad("//skport.com/a.png");
bad("");
bad(undefined);
bad(["https://skport.com/a.png"]);

assert.equal(extensionForContentType("image/png"), ".png");
assert.equal(extensionForContentType("image/jpeg"), ".jpg");
assert.equal(extensionForContentType("image/webp; charset=x"), ".webp");
assert.equal(extensionForContentType("IMAGE/GIF"), ".gif");
assert.equal(extensionForContentType("image/svg+xml"), null);
assert.equal(extensionForContentType("text/html"), null);
assert.equal(extensionForContentType("application/octet-stream"), null);
assert.equal(extensionForContentType("image/x-weird"), null);
assert.equal(extensionForContentType(undefined), null);

assert.equal(isServableCacheFile("a/b.png"), true);
assert.equal(isServableCacheFile("a/b.html"), false);
assert.equal(isServableCacheFile("a/b.svg"), false);
assert.equal(isServableCacheFile("a/b.js"), false);

function body(...parts: string[]) {
  return (async function* () {
    for (const p of parts) yield Buffer.from(p);
  })();
}
const resp = (status: number, headers: any, parts: string[] = []) => ({
  status,
  headers,
  body: body(...parts),
  abort() {},
});

async function main() {
  // happy path
  {
    const img = await fetchProxiedImage(
      "https://static.skport.com/a",
      async () => resp(200, { "content-type": "image/png" }, ["ab", "cd"]),
    );
    assert.equal(img.buffer.toString(), "abcd");
    assert.equal(img.ext, ".png");
  }
  // refuses disallowed initial url without requesting
  {
    let called = 0;
    await assert.rejects(
      fetchProxiedImage("https://evil.com/a", async () => {
        called++;
        return resp(200, { "content-type": "image/png" });
      }),
    );
    assert.equal(called, 0);
  }
  // redirect to disallowed host is refused (re-check per hop)
  {
    const seen: string[] = [];
    const req: RawRequest = async (u) => {
      seen.push(u.toString());
      return resp(302, { location: "https://evil.com/x.png" });
    };
    await assert.rejects(fetchProxiedImage("https://skport.com/a", req));
    assert.deepEqual(seen, ["https://skport.com/a"]);
  }
  // redirect to http / internal refused
  await assert.rejects(
    fetchProxiedImage("https://skport.com/a", async () =>
      resp(302, { location: "http://127.0.0.1/x" }),
    ),
  );
  // allowed redirect followed; limit of 3
  {
    let n = 0;
    const req: RawRequest = async () => {
      n++;
      if (n <= 3) return resp(302, { location: "/r" + n });
      return resp(200, { "content-type": "image/webp" }, ["x"]);
    };
    const img = await fetchProxiedImage("https://skport.com/a", req);
    assert.equal(img.ext, ".webp");
    let m = 0;
    await assert.rejects(
      fetchProxiedImage("https://skport.com/a", async () => {
        m++;
        return resp(302, { location: "/loop" });
      }),
      /too many redirects/,
    );
    assert.equal(m, 4);
  }
  // svg / html refused
  for (const ct of ["image/svg+xml", "text/html"]) {
    await assert.rejects(
      fetchProxiedImage("https://skport.com/a", async () =>
        resp(200, { "content-type": ct }, ["<svg/>"]),
      ),
    );
  }
  // size cap aborts the stream; declared length rejected up front
  {
    let aborted = false;
    await assert.rejects(
      fetchProxiedImage(
        "https://skport.com/a",
        async () => ({
          ...resp(200, { "content-type": "image/png" }, ["12345", "67890"]),
          abort() {
            aborted = true;
          },
        }),
        { maxBytes: 8 },
      ),
      /too large/,
    );
    assert.equal(aborted, true);
    await assert.rejects(
      fetchProxiedImage(
        "https://skport.com/a",
        async () =>
          resp(200, { "content-type": "image/png", "content-length": "99" }),
        { maxBytes: 8 },
      ),
      /too large/,
    );
  }
  // timeout
  await assert.rejects(
    fetchProxiedImage(
      "https://skport.com/a",
      (_u, signal) =>
        new Promise((_res, rej) =>
          signal.addEventListener("abort", () => rej(new Error("aborted"))),
        ),
      { timeoutMs: 50 },
    ),
    /timeout/,
  );

  // cache write / find / evict
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ef-proxy-"));
  try {
    const url = "https://skport.com/a";
    assert.equal(findCached(dir, url), null);
    const p = await writeCached(dir, url, {
      buffer: Buffer.from("x"),
      contentType: "image/png",
      ext: ".png",
    });
    assert.equal(findCached(dir, url), p);
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
    );
    // legacy dangerous files are purged; oldest evicted first
    const old = new Date(Date.now() - 3600_000);
    for (const f of ["old.html", "old.svg"]) {
      fs.writeFileSync(path.join(dir, f), "<script>");
      fs.utimesSync(path.join(dir, f), old, old);
    }
    fs.writeFileSync(path.join(dir, "fresh.tmp"), "in flight");
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `f${i}.png`);
      fs.writeFileSync(f, "12345678");
      const t = new Date(Date.now() - (10 - i) * 60_000);
      fs.utimesSync(f, t, t);
    }
    // the first written file (p) is the newest image
    const deleted = evictCache(dir, { maxFiles: 3, maxBytes: 1e9 });
    const left = fs.readdirSync(dir).sort();
    assert.equal(deleted, 2 + 3); // 2 legacy + 3 oldest (6 images -> 3)
    assert.ok(!left.includes("old.html") && !left.includes("old.svg"));
    assert.ok(left.includes("fresh.tmp")); // in-flight temp kept
    assert.ok(left.includes("f4.png") && !left.includes("f0.png"));
    // byte cap
    fs.rmSync(path.join(dir, "fresh.tmp"));
    evictCache(dir, { maxBytes: 8, maxFiles: 100 });
    assert.ok(fs.readdirSync(dir).length <= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("imageProxy tests passed");
}
main();
