import assert from "node:assert/strict";
import { Events } from "discord.js";

const Module: any = require("node:module");
const originalLoad = Module._load;
const previousCluster = process.env.CLUSTER;
const reports: number[] = [];
const clients: any[] = [];

class FakeClusterClient {
  public id = 0;
  public triggerReady() {
    reports.push(this.id);
  }
}

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "discord-hybrid-sharding") {
    return {
      ClusterClient: FakeClusterClient,
      AutoResharderClusterClient: class {},
      getInfo: () => ({ SHARD_LIST: [0], TOTAL_SHARDS: 1 }),
    };
  }
  if (request === "../utils/Database") {
    return { CustomDatabase: class {} };
  }
  if (request === "dotenv") return { config: () => undefined };
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    const { ExtendedClient } = require("../structures/Client");
    process.env.CLUSTER = "0";
    const sharded = new ExtendedClient();
    clients.push(sharded);
    assert.deepEqual(
      reports,
      [],
      "do not report ready before Discord is ready",
    );
    sharded.emit(Events.ClientReady, sharded);
    assert.deepEqual(
      reports,
      [0],
      "report readiness to enable manager recovery",
    );
    sharded.emit(Events.ClientReady, sharded);
    assert.deepEqual(reports, [0], "report once for each worker process");

    delete process.env.CLUSTER;
    const standalone = new ExtendedClient();
    clients.push(standalone);
    standalone.emit(Events.ClientReady, standalone);
    assert.deepEqual(
      reports,
      [0],
      "standalone clients have no manager to notify",
    );
    // start(): success is logged only after login resolves; a login failure exits non-zero
    {
      const prevToken = process.env.DISCORD_TOKEN;
      const prevEnv = process.env.NODE_ENV;
      process.env.DISCORD_TOKEN = "unit-test-token";
      process.env.NODE_ENV = "production";
      const c: any = new ExtendedClient();
      clients.push(c);
      const events: string[] = [];
      c.logger = {
        info: () => {},
        error: (m: string) => events.push("error:" + m),
        success: (m: string) => events.push("success:" + m),
      };
      let release!: () => void;
      c.login = () =>
        new Promise<string>((resolve) => {
          release = () => resolve("ok");
        });
      const pending = c.start();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(events.length, 0, "no success log before login resolves");
      release();
      await pending;
      assert.equal(events.length, 1);
      assert.match(events[0], /^success:/);
      c.stop();

      const realExit = process.exit;
      const exits: unknown[] = [];
      (process as any).exit = (code?: number) => void exits.push(code);
      try {
        c.login = () => Promise.reject(new Error("TOKEN_INVALID"));
        await c.start();
      } finally {
        (process as any).exit = realExit;
        c.stop();
      }
      assert.deepEqual(exits, [1], "login failure exits with code 1");
      assert.ok(events.some((e) => e.startsWith("error:Login failed")));
      assert.equal(events.filter((e) => e.startsWith("success:")).length, 1);
      if (prevToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = prevToken;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
    console.log("cluster ready regression tests passed");
  } finally {
    Module._load = originalLoad;
    if (previousCluster === undefined) delete process.env.CLUSTER;
    else process.env.CLUSTER = previousCluster;
    await Promise.all(clients.map((client) => client.destroy()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
