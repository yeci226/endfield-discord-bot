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
