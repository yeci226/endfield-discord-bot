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
