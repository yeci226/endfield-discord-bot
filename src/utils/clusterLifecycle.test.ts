import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const Module: any = require("node:module");
const originalLoad = Module._load;
const previousNodeEnv = process.env.NODE_ENV;
const previousToken = process.env.DISCORD_TOKEN;
const managers: any[] = [];

class FakeReClusterManager {
  public name = "recluster";
  public manager: any;
  public startCalls = 0;
  public respawnDuringStart: boolean | undefined;
  public failNext = false;

  async start() {
    this.startCalls++;
    this.respawnDuringStart = this.manager.respawn;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated recluster failure");
    }
    return { success: true };
  }
}

class FakePlugin {
  constructor(public name: string) {}
}

class FakeClusterManager extends EventEmitter {
  public respawn = true;
  public recluster = new FakeReClusterManager();
  public spawnCalls = 0;

  constructor(_file: string, _options: unknown) {
    super();
    managers.push(this);
  }

  extend(...plugins: any[]) {
    for (const plugin of plugins) {
      if (plugin.name === "recluster") {
        this.recluster = plugin;
        this.recluster.manager = this;
      }
    }
    return this;
  }

  async spawn() {
    this.spawnCalls++;
  }
}

process.env.NODE_ENV = "production";
process.env.DISCORD_TOKEN = "unit-test-token";
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "discord-hybrid-sharding") {
    return {
      ClusterManager: FakeClusterManager,
      ReClusterManager: FakeReClusterManager,
      HeartbeatManager: class extends FakePlugin {
        constructor() { super("heartbeat"); }
      },
      AutoResharderManager: class extends FakePlugin {
        constructor() { super("autoresharder"); }
      },
    };
  }
  if (request === "dotenv") return { config: () => undefined };
  if (request === "./utils/Logger") {
    return {
      Logger: class {
        info() {}
        error() {}
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let manager: any;
try {
  require("../cluster");
  manager = managers[0];
} finally {
  Module._load = originalLoad;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = previousToken;
}

async function main() {
  assert.ok(manager, "cluster manager should be constructed by the entrypoint");
  const cluster = new EventEmitter() as any;
  cluster.id = 0;
  manager.emit("clusterCreate", cluster);
  cluster.emit("death");
  assert.equal(
    manager.recluster.startCalls,
    0,
    "a single worker death must not launch a second full recluster; built-in respawn owns recovery",
  );

  // one memory timer per cluster id: a respawn ("ready" again) replaces it, death clears it
  {
    const realSet = global.setInterval;
    const realClear = global.clearInterval;
    const live = new Set<unknown>();
    (global as any).setInterval = (fn: () => void, ms: number) => {
      const handle = realSet(fn, ms);
      handle.unref();
      live.add(handle);
      return handle;
    };
    (global as any).clearInterval = (handle: unknown) => {
      live.delete(handle);
      realClear(handle as any);
    };
    try {
      const c1 = new EventEmitter() as any;
      c1.id = 1;
      manager.emit("clusterCreate", c1);
      c1.emit("ready");
      c1.emit("ready");
      c1.emit("ready");
      assert.equal(live.size, 1, "respawned cluster must not stack timers");
      const c2 = new EventEmitter() as any;
      c2.id = 2;
      manager.emit("clusterCreate", c2);
      c2.emit("ready");
      assert.equal(live.size, 2, "one timer per cluster id");
      c1.emit("death");
      assert.equal(live.size, 1, "death clears the timer");
      c2.emit("death");
      assert.equal(live.size, 0);
    } finally {
      global.setInterval = realSet;
      global.clearInterval = realClear;
    }
  }

  await manager.recluster.start();
  assert.equal(
    manager.recluster.respawnDuringStart,
    false,
    "disable per-cluster respawn while the recluster plugin intentionally replaces old workers",
  );
  assert.equal(manager.respawn, true, "restore normal worker respawn after recluster");

  manager.recluster.failNext = true;
  await assert.rejects(manager.recluster.start(), /simulated recluster failure/);
  assert.equal(manager.respawn, true, "restore normal respawn if reclustering fails");

  console.log("cluster lifecycle recovery regression tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
