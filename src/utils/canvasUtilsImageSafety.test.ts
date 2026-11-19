import assert from "node:assert/strict";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import {
  drawProfileBackground,
  fetchImage,
  loadAssetImage,
  resolveAssetPath,
  validateRendererImageUrl,
} from "./canvasUtils";

const ASSETS = path.join(__dirname, "..", "assets");

async function main() {
  // ---- asset paths stay inside the assets folder
  const inside = resolveAssetPath("star.png");
  assert.equal(inside, path.join(ASSETS, "star.png"));
  assert.equal(resolveAssetPath("../package.json"), null);
  assert.equal(resolveAssetPath("../../package.json"), null);
  assert.equal(resolveAssetPath("phase/../../secret.png"), null);
  assert.equal(resolveAssetPath("a/../../b.png"), null);
  assert.equal(resolveAssetPath(""), null);
  assert.equal(resolveAssetPath("star.png" + String.fromCharCode(0)), null);
  // an absolute-looking path is joined under the folder, never used as is
  const abs = resolveAssetPath("/etc/passwd");
  assert.ok(abs === null || abs.startsWith(ASSETS + path.sep));
  assert.equal(resolveAssetPath("..", ASSETS), null);
  assert.equal(resolveAssetPath("x.png", path.join(ASSETS, "gem")), path.join(ASSETS, "gem", "x.png"));

  assert.equal(await loadAssetImage("../package.json"), null);
  assert.equal(await loadAssetImage("does-not-exist.png"), null);
  const star = await loadAssetImage("star.png");
  assert.ok(star && star.width > 0);

  // ---- host allow-list (web proxy list + the two icon mirrors)
  const ok = [
    "https://bbs.hycdn.cn/image/a.png",
    "https://static.skport.com/a.png",
    "https://web-api.skport.com/a.png",
    "https://ef-webview.gryphline.com/a.png",
    "https://cdn.discordapp.com/avatars/1/2.png",
    "https://media.discordapp.net/a.png",
    "https://endfieldtools.dev/assets/images/endfield/charicon/icon_x.png",
    "https://endfield.ooo.run/ake/operators/icon_x.webp",
  ];
  for (const u of ok) assert.equal(validateRendererImageUrl(u).ok, true, u);
  const bad = [
    "https://evil.com/a.png",
    "https://skport.com.evil.com/a.png",
    "https://evil-skport.com/a.png",
    "https://endfieldtools.dev.evil.com/a.png",
    "https://notendfieldtools.dev/a.png",
    "http://static.skport.com/a.png",
    "https://user:pw@static.skport.com/a.png",
    "https://static.skport.com:8443/a.png",
    "https://127.0.0.1/a.png",
    "https://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "/assets/star.png",
    "",
  ];
  for (const u of bad) assert.equal(validateRendererImageUrl(u).ok, false, u);
  assert.equal(validateRendererImageUrl(undefined).ok, false);

  // ---- fetchImage refuses a bad host before any request
  const realGet = axios.get;
  let requests: string[] = [];
  (axios as any).get = async (url: string) => {
    requests.push(url);
    throw new Error("network must not be reached");
  };
  try {
    await assert.rejects(fetchImage("https://evil.invalid/a.png"), /not allowed/);
    await assert.rejects(fetchImage("http://static.skport.com/a.png"), /not allowed/);
    assert.deepEqual(requests, []);

    // a redirect to a non-allow-listed host is refused (axios never follows it)
    requests = [];
    (axios as any).get = async (url: string, cfg: any) => {
      requests.push(url);
      assert.equal(cfg.maxRedirects, 0);
      return {
        status: 302,
        headers: { location: "https://evil.invalid/steal.png" },
        data: Buffer.alloc(0),
      };
    };
    await assert.rejects(
      fetchImage("https://static.skport.com/redirect-test-a.jpg"),
      /redirect refused/,
    );
    assert.deepEqual(requests, ["https://static.skport.com/redirect-test-a.jpg"]);

    // a redirect inside the allow-list is followed
    requests = [];
    const png = createCanvas(2, 2).toBuffer("image/png");
    (axios as any).get = async (url: string) => {
      requests.push(url);
      if (url.includes("hop1")) {
        return {
          status: 302,
          headers: { location: "https://bbs.hycdn.cn/hop2.png" },
          data: Buffer.alloc(0),
        };
      }
      return { status: 200, headers: {}, data: png };
    };
    const cacheName = "g4test_safety_" + process.pid;
    const img = await fetchImage(
      "https://static.skport.com/hop1.png",
      cacheName,
    );
    assert.equal(img.width, 2);
    assert.equal(requests.length, 2);
    const cacheFile = path.join(ASSETS, "remote_cache", cacheName + ".png");
    assert.ok(fs.existsSync(cacheFile));
    fs.unlinkSync(cacheFile);

    // a cache name carrying path pieces stays inside remote_cache
    requests = [];
    (axios as any).get = async (url: string) => {
      requests.push(url);
      return { status: 200, headers: {}, data: png };
    };
    const evilName = "../../g4test_evil_" + process.pid;
    await fetchImage("https://static.skport.com/trav.png", evilName);
    const escaped = path.join(ASSETS, "..", "g4test_evil_" + process.pid + ".png");
    assert.ok(!fs.existsSync(escaped));
    const landed = fs
      .readdirSync(path.join(ASSETS, "remote_cache"))
      .filter((f) => f.includes("g4test_evil_" + process.pid));
    assert.equal(landed.length, 1);
    fs.unlinkSync(path.join(ASSETS, "remote_cache", landed[0]));
  } finally {
    (axios as any).get = realGet;
  }

  // ---- profile background: traversal / foreign host render as "missing"
  for (const url of [
    "../../package.json",
    "../package.json",
    "https://evil.invalid/bg.png",
  ]) {
    const cv = createCanvas(40, 40);
    const ctx = cv.getContext("2d");
    await drawProfileBackground(ctx, 40, 40, {
      background: { url },
    } as any);
  }
}

main();
