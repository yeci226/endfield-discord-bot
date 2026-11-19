import assert from "node:assert/strict";

// The event module builds webhooks from env at import time; none are set here.
delete process.env.CMDWEBHOOK;
// telemetry is compiled-only (".js" specifier); stand in a pass-through tracker.
const Module: any = require("node:module");
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "../telemetry.js")
    return { trackCommand: (_i: unknown, fn: () => unknown) => fn() };
  return originalLoad.call(this, request, parent, isMain);
};
const mod = require("./interactionCreate");
Module._load = originalLoad;

async function main() {
  assert.equal(typeof mod.invalidateLocaleCache, "function");
  assert.equal(mod.default.name, "interactionCreate");

  // A user over the limit gets exactly one localized notice per window; the command never runs.
  const notices: string[] = [];
  let executed = 0;
  const client: any = {
    db: { get: async () => "en" },
    commands: new Map([
      ["ping", { data: { name: "ping" }, execute: async () => void executed++ }],
    ]),
  };
  const make = (id: string) => ({
    user: { id, tag: id },
    locale: "en-US",
    commandName: "ping",
    isButton: () => false,
    isModalSubmit: () => false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    deferred: false,
    replied: false,
    ephemeral: true,
    options: { getSubcommand: () => null, getSubcommandGroup: () => null },
    reply: async (p: any) => void notices.push(p.content),
    followUp: async () => {},
    deleteReply: async () => {},
  });
  for (let i = 0; i < 40; i++) await mod.default.execute(client, make("spammer"));
  assert.equal(executed, 20, "only the first 20 interactions run");
  assert.equal(notices.length, 1, "one notice per window, not one per rejected interaction");
  assert.match(notices[0], /too fast/);
  await mod.default.execute(client, make("other-user"));
  assert.equal(executed, 21, "limits are per user");

  // autocomplete has its own bucket and answers [] once exceeded
  let responded: any[] = [];
  const auto = (id: string) => ({
    user: { id },
    locale: "en-US",
    commandName: "ping",
    isButton: () => false,
    isModalSubmit: () => false,
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    respond: async (v: any) => void responded.push(v),
  });
  client.commands.get("ping").autocomplete = async (_c: any, i: any) =>
    i.respond([{ name: "x", value: "x" }]);
  for (let i = 0; i < 65; i++) await mod.default.execute(client, auto("typist"));
  assert.equal(responded.filter((r) => r.length === 1).length, 60);
  assert.equal(responded.filter((r) => r.length === 0).length, 5);
  assert.equal(executed, 21, "typing does not consume the command bucket");

  // a throwing component handler still answers the user
  client.commands.set("boom", {
    data: { name: "boom" },
    execute: async () => {
      throw new Error("kaboom");
    },
  });
  const sent: any[] = [];
  const btn: any = {
    user: { id: "clicker" },
    locale: "en-US",
    customId: "boom:x",
    isButton: () => true,
    isModalSubmit: () => false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    deferred: true,
    replied: false,
    followUp: async (p: any) => void sent.push(p),
  };
  await mod.default.execute(client, btn);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].flags, 64);

  console.log("interactionCreate tests passed");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
