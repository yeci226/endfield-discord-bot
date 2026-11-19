# Wave 0: Shared Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the later parallel lanes a test command, a few database helpers, cluster-0 startup hooks, a tolerant command loader and per-lane language-file blocks, with zero change in bot behaviour.

**Architecture:** Everything is additive. New helpers are new methods/files; the three existing files that change (`commandHandler.ts`, `ready.ts`, `Client.ts`) keep their current behaviour for all current inputs.

**Tech Stack:** TypeScript 5.9 (CommonJS, target ES6), Node 24 locally / Node 22 in production, better-sqlite3, discord.js 14, ts-node (already a devDependency). Tests are plain `node:assert/strict` scripts named `*.test.ts` that call a `main()` at the bottom.

**Spec:** `docs/superpowers/specs/2026-11-19-bot-optimization-design.md` (section 5 and "第 0 波" in section 6).

## Global Constraints

- Branch `opt/w0`, cut from `opt/2026-11`. Work only in your own git worktree. Commit after each task. Never push.
- No new npm dependencies.
- Bot behaviour must not change. Do not start the bot. Do not read `.env`.
- Existing public API of `CustomDatabase` stays exactly as it is.
- Keep each file's existing line endings; do not reformat lines you are not changing (no Prettier over whole files).
- Code must work on Windows (dev) and macOS (production): build paths with `path.join`, temp files under `os.tmpdir()`.
- `commands-manifest.json` is stale and unused: do not touch it.
- Every task ends with `npx tsc --noEmit` passing.

## Review Focus

1. A prefix containing `_` or `%` (`deleteByPrefix("a_")`) must be treated literally: it must not delete `ab1`. → Task 2.
2. `update()` whose callback throws must write nothing and rethrow. → Task 2.
3. `withKeyLock`: a rejected holder must not block the next waiter; different keys must not wait for each other. → Task 2.
4. A periodic hook that throws, or runs longer than its interval, must not stop later ticks and must not overlap itself. → Task 3.
5. A command file that throws on import, or has no `default.data.name`, must not stop the other commands from loading. → Task 4.

---

### Task 1: Test runner

**Files:**
- Create: `scripts/run-tests.js`
- Create: `scripts/known-failing-tests.json`
- Create: `tsconfig.build.json`
- Modify: `package.json` (scripts only)

**Interfaces:**
- Produces: `yarn test` (exit 0 = all tests pass or are listed as known-failing); `yarn test <substring>` runs only test files whose path contains the substring.

- [ ] **Step 1:** In the worktree run `yarn install --frozen-lockfile`. Then run every `src/**/*.test.ts` once by hand with `node -r ts-node/register <file>` and note which exit non-zero on the untouched checkout.

- [ ] **Step 2:** Write `scripts/run-tests.js` (CommonJS, no dependencies beyond Node):
  - recursively collects `src/**/*.test.ts`, sorted; optional `process.argv[2]` substring filter;
  - runs each in its own child process: `node -r ts-node/register <file>` with env `TS_NODE_TRANSPILE_ONLY=1` and `NODE_ENV=test`, 120 s timeout;
  - prints one line per file: `PASS`, `FAIL` (followed by the child's stderr), or `KNOWN-FAIL`;
  - reads `scripts/known-failing-tests.json` (array of repo-relative POSIX paths); a failing file listed there prints `KNOWN-FAIL` and does not fail the run; a listed file that now passes prints `PASS (remove from known-failing)`;
  - prints a final `N passed, N failed, N known-failing`; exits 1 if any `FAIL`.

- [ ] **Step 3:** Put the files found failing in Step 1 into `scripts/known-failing-tests.json` (`[]` if none). Do not fix them.

- [ ] **Step 4:** `package.json` scripts: add `"test": "node scripts/run-tests.js"`; change `build` to `"tsc -p tsconfig.build.json && node scripts/copy-assets.js"`. `tsconfig.build.json`:

```json
{ "extends": "./tsconfig.json", "exclude": ["node_modules", "src/**/*.test.ts"] }
```

- [ ] **Step 5:** Run `yarn test` → exit 0, summary line printed. Run `npx tsc -p tsconfig.build.json --noEmit` → no output.

- [ ] **Step 6:** Commit `chore(test): add test runner and build config that skips tests`.

---

### Task 2: Database helpers

**Files:**
- Modify: `src/utils/Database.ts` (add methods at the end of the class; change nothing else)
- Test: `src/utils/Database.test.ts`

**Interfaces:**
- Produces (all synchronous unless noted, all on `CustomDatabase`):
  - `setWithTtl(key: string, value: unknown, ttlMs: number): void` — stores `{ v: value, exp: Date.now() + ttlMs }`.
  - `getFresh<T = any>(key: string): T | null` — returns `v` while `exp > Date.now()`; otherwise deletes the row and returns `null`. A row that is not in the `{v, exp}` shape returns `null` and is left alone.
  - `deleteByPrefix(prefix: string): number` — deletes rows with `ID >= prefix AND ID < prefix + "￿"`, returns the number deleted. Throws on an empty prefix.
  - `update<T = any>(key: string, fn: (current: T | null) => T | null): T | null` — one `IMMEDIATE` transaction: read, call `fn`, write the result (`null` deletes the row), return the result. `fn` must be synchronous (throw `Error("Database update callbacks must be synchronous")` if it returns a thenable, same as `transaction`).
  - `withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T>` — in-process mutex per key (a `Map<string, Promise<unknown>>` chain); resolves/rejects with `fn`'s result; the map entry is removed when no one is waiting.
  - `close(): void` — closes the underlying connection (needed by tests on Windows to delete the temp file).

- [ ] **Step 1: Write the failing test** `src/utils/Database.test.ts`. Each case opens `new CustomDatabase(path.join(os.tmpdir(), "ef-db-test-" + process.pid + "-" + n + ".sqlite"))` and closes + deletes it afterwards. Assertions:

```ts
// ttl
db.setWithTtl("t.a", { x: 1 }, 60_000);
assert.deepEqual(db.getFresh("t.a"), { x: 1 });
db.setWithTtl("t.b", 1, -1);
assert.equal(db.getFresh("t.b"), null);
assert.equal(await db.get("t.b"), null);            // expired row was deleted
await db.set("t.c", { plain: true });
assert.equal(db.getFresh("t.c"), null);
assert.deepEqual(await db.get("t.c"), { plain: true }); // foreign shape untouched

// deleteByPrefix is literal
await db.set("a_1", 1); await db.set("a_2", 2); await db.set("ab1", 3); await db.set("a%x", 4);
assert.equal(db.deleteByPrefix("a_"), 2);
assert.equal(await db.get("ab1"), 3);
assert.equal(await db.get("a%x"), 4);
assert.throws(() => db.deleteByPrefix(""));

// update
assert.equal(db.update<number>("u.n", (c) => (c ?? 0) + 1), 1);
assert.equal(db.update<number>("u.n", (c) => (c ?? 0) + 1), 2);
assert.throws(() => db.update("u.n", () => { throw new Error("boom"); }), /boom/);
assert.equal(await db.get("u.n"), 2);                // nothing written
assert.equal(db.update("u.n", () => null), null);
assert.equal(await db.get("u.n"), null);             // null deletes
assert.throws(() => db.update("u.n", (() => Promise.resolve(1)) as any), /synchronous/);

// withKeyLock: same key serialises, rejection does not block, other keys are independent
const order: string[] = [];
const slow = db.withKeyLock("k", async () => { await sleep(40); order.push("a"); throw new Error("x"); });
const next = db.withKeyLock("k", async () => { order.push("b"); return 7; });
const other = db.withKeyLock("other", async () => { order.push("c"); });
await assert.rejects(slow, /x/);
assert.equal(await next, 7);
await other;
assert.deepEqual(order, ["c", "a", "b"]);
```

- [ ] **Step 2:** `yarn test Database.test` → FAIL (methods do not exist).
- [ ] **Step 3:** Implement the six methods.
- [ ] **Step 4:** `yarn test Database.test` → PASS; `yarn test` → exit 0; `npx tsc --noEmit` → no output.
- [ ] **Step 5:** Commit `feat(db): ttl, prefix delete, atomic update and key lock helpers`.

---

### Task 3: Startup hooks

**Files:**
- Create: `src/utils/startup.ts`
- Modify: `src/structures/Client.ts` (add the `startup` property, construct it next to `this.logger`)
- Modify: `src/events/ready.ts` (one line at the end of `execute`)
- Test: `src/utils/startup.test.ts`

**Interfaces:**
- Produces:

```ts
export interface StartupLogger { info(msg: string): void; error(msg: string, err?: unknown): void; }
export class StartupHooks {
  constructor(logger: StartupLogger);
  /** Runs once on the primary cluster (cluster id 0) after ready. */
  onPrimary(name: string, fn: () => void | Promise<void>): void;
  /** Runs every intervalMs on the primary cluster after ready; first run after one interval. */
  every(name: string, intervalMs: number, fn: () => void | Promise<void>): void;
  /** Called once from the ready event. Non-primary clusters do nothing. Never throws. */
  run(isPrimary: boolean): Promise<void>;
  stop(): void; // clears all intervals
}
```

  - `client.startup: StartupHooks` on `ExtendedClient`.
  - A hook registered after `run(true)` has already been called starts immediately (one-shot runs now; periodic starts its timer now). A hook registered after `run(false)` is ignored.
  - A throwing/rejecting hook is logged with its name and never propagates. A periodic hook whose previous run has not finished skips that tick. Timers are `unref()`ed.
  - Registering the same name twice throws `Error("Startup hook already registered: <name>")`.

- [ ] **Step 1: Write the failing test** `src/utils/startup.test.ts` with a fake logger that collects messages:

```ts
// non-primary runs nothing
// primary: onPrimary hooks run once, in registration order
// a throwing onPrimary hook is logged (error message contains its name) and the next hook still runs
// every(): with intervalMs 20 and a fn that throws on its first call, after ~110ms the call count is >= 3
// every(): with intervalMs 10 and a fn that awaits 50ms, max concurrent executions observed === 1
// late registration: after run(true), onPrimary("late", fn) calls fn without another run()
// duplicate name throws /already registered/
// stop(): no further calls after stop()
```

  Write each comment as a real assertion.

- [ ] **Step 2:** `yarn test startup.test` → FAIL.
- [ ] **Step 3:** Implement `StartupHooks`; add `public startup: StartupHooks` to `ExtendedClient`, constructed with an adapter around the existing `Logger`; at the end of `ready.ts` `execute` add `await client.startup.run(client.cluster.id === 0);`.
- [ ] **Step 4:** `yarn test` → exit 0; `npx tsc --noEmit` → no output.
- [ ] **Step 5:** Commit `feat(startup): primary-cluster startup and periodic hooks`.

---

### Task 4: Tolerant command loader

**Files:**
- Modify: `src/handlers/commandHandler.ts`
- Test: `src/handlers/commandHandler.test.ts`

**Interfaces:**
- Produces: `loadCommandsFrom(client: { commands: Map<string, Command> | Collection<string, Command> }, dir: string): Promise<{ loaded: string[]; skipped: string[]; failed: string[] }>` (arrays hold file paths, except `loaded` which holds command names). `loadCommands(client)` keeps its signature and calls it with the existing `../commands` path.
- Rules: candidate files end in `.ts` or `.js` but not `.d.ts`, `.test.ts`, `.test.js`. Import inside try/catch: an import error → `logger.error` with the file path, add to `failed`, continue. A module whose default export lacks `data.name` (string) or `execute` (function) → `logger.warn`, add to `skipped`, continue. Remove the unused `getFiles`.

- [ ] **Step 1: Write the failing test.** Build a temp dir under `os.tmpdir()` with `.js` fixtures: `good.js` (`exports.default = { data: { name: "good" }, execute() {} }`), `sub/nested.js` (name `"nested"`), `throws.js` (`throw new Error("bad import")`), `helper.js` (`exports.helper = 1`), `good.test.js` (would throw if imported). Assert `client.commands` has exactly `good` and `nested`; `failed` has 1 entry ending in `throws.js`; `skipped` has 1 entry ending in `helper.js`; the promise resolves.
- [ ] **Step 2:** `yarn test commandHandler.test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `yarn test` → exit 0; `npx tsc --noEmit` → no output.
- [ ] **Step 5:** Commit `fix(commands): one broken command file no longer aborts startup`.

---

### Task 5: Per-lane language blocks

**Files:**
- Modify: `src/assets/languages/en.ts`, `src/assets/languages/tw.ts`

- [ ] **Step 1:** In both files, immediately before the closing `};` of the `langs` object, append these comment lines, each followed by one blank line, in this order:

```ts
  // --- L2 (web & credentials) ---

  // --- L3 (daily & account) ---

  // --- L4 (news, reminders, core) ---

  // --- L5 (new commands A) ---

  // --- G1 (gacha security) ---

  // --- G2 (gacha leaderboard & storage) ---

  // --- G3 (gacha stats) ---

  // --- G4 (gacha rendering) ---
```

- [ ] **Step 2:** `npx tsc --noEmit` → no output; `yarn test` → exit 0.
- [ ] **Step 3:** Commit `chore(i18n): per-lane blocks at the end of the language files`.

---

## Final report (what the implementer hands back)

- The commit list on `opt/w0`.
- Final output of `yarn test` and `npx tsc --noEmit`.
- The contents of `scripts/known-failing-tests.json` with, for each entry, the one-line reason it fails on the untouched checkout.
- Anything in this plan you had to deviate from, and why.
