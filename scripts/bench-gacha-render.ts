/**
 * Render benchmark for the gacha stats cards.
 *
 *   node -r ts-node/register scripts/bench-gacha-render.ts            # current code
 *   node -r ts-node/register scripts/bench-gacha-render.ts --no-cache # old path: no image cache, no card cache
 *
 * Network images are the fixture's local placeholders (see
 * render-gacha-fixture.ts), so this measures drawing + decoding + caching, not
 * the network. For two cards (overview, one detail page) it prints the median
 * of 10 runs for:
 *   cold   a fresh process, first render (fonts, JIT and caches all empty)
 *   warm   same process, card cache bypassed, image caches warm
 *   hit    same process, card cache on (the repeat view of an unchanged log)
 * and the peak RSS of the process that did the warm/hit runs.
 */
import { spawnSync } from "child_process";
import { prepareFixture } from "./render-gacha-fixture";
import { drawGachaStats } from "../src/utils/gachaCanvasUtils";
import { renderedCardCache } from "../src/features/gacha/statsCanvas/cardCache";
import { decodedImageCache } from "../src/utils/byteLruCache";

const RUNS = 10;
const noCache = process.argv.includes("--no-cache");
const isChild = process.argv.includes("--child");

const CARDS: Array<{ name: string; poolId?: string; type: any }> = [
  { name: "overview", type: "limited_char" },
  { name: "detail", type: "limited_char", poolId: "c_special_1_0_1" },
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const fmt = (n: number) => n.toFixed(1).padStart(8) + " ms";

async function timeRender(
  ctx: Awaited<ReturnType<typeof prepareFixture>>,
  card: (typeof CARDS)[number],
): Promise<number> {
  const t0 = process.hrtime.bigint();
  await drawGachaStats(
    ctx.data,
    ctx.stats,
    ctx.tr,
    card.type,
    card.poolId,
    0,
    ctx.db,
  );
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function applyFlags() {
  if (noCache) {
    renderedCardCache.enabled = false;
    decodedImageCache.enabled = false;
  }
}

async function childMain() {
  applyFlags();
  const ctx = await prepareFixture();
  const idx = Number(process.argv[process.argv.indexOf("--child") + 1]);
  const ms = await timeRender(ctx, CARDS[idx]);
  process.stdout.write(JSON.stringify({ ms }) + "\n");
  process.exit(0);
}

async function main() {
  applyFlags();
  const mode = noCache ? "NO CACHE (old path)" : "caches on";
  console.log(`gacha render bench, ${RUNS} runs, ${mode}`);

  const results: Record<string, { cold: number; warm: number; hit: number }> =
    {};
  for (let c = 0; c < CARDS.length; c++) {
    const card = CARDS[c];
    const cold: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const res = spawnSync(
        process.execPath,
        [
          "-r",
          "ts-node/register",
          __filename,
          "--child",
          String(c),
          ...(noCache ? ["--no-cache"] : []),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1", NODE_ENV: "test" },
        },
      );
      if (res.status !== 0) throw new Error(res.stderr);
      cold.push(JSON.parse(res.stdout.trim().split("\n").pop()!).ms);
    }
    results[card.name] = { cold: median(cold), warm: 0, hit: 0 };
  }

  const ctx = await prepareFixture();
  for (const card of CARDS) {
    // warm the image caches once, then time with the card cache bypassed
    const hadCardCache = renderedCardCache.enabled;
    renderedCardCache.enabled = false;
    await timeRender(ctx, card);
    const warm: number[] = [];
    for (let i = 0; i < RUNS; i++) warm.push(await timeRender(ctx, card));
    renderedCardCache.enabled = hadCardCache;

    renderedCardCache.clear();
    await timeRender(ctx, card); // fills the card cache (no-op when bypassed)
    const hit: number[] = [];
    for (let i = 0; i < RUNS; i++) hit.push(await timeRender(ctx, card));
    results[card.name].warm = median(warm);
    results[card.name].hit = median(hit);
  }

  console.log("card       cold(fresh process)        warm        card-cache hit");
  for (const card of CARDS) {
    const r = results[card.name];
    console.log(
      `${card.name.padEnd(9)} ${fmt(r.cold)}   ${fmt(r.warm)}   ${fmt(r.hit)}`,
    );
  }
  const rss = process.resourceUsage().maxRSS / 1024;
  console.log(`peak RSS of the warm/hit process: ${rss.toFixed(0)} MB`);
  console.log(
    `decoded-image cache: ${decodedImageCache.size} images, ${(decodedImageCache.bytes / 1048576).toFixed(1)} MB; card cache: ${renderedCardCache.size} cards, ${(renderedCardCache.bytes / 1048576).toFixed(2)} MB`,
  );
  process.exit(0);
}

(isChild ? childMain() : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
