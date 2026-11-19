import assert from "node:assert/strict";
import { createTranslator } from "../../utils/i18n";

const accountUtils = require("../../utils/accountUtils");
const skportApi = require("../../utils/skportApi");
const originals = {
  getAccounts: accountUtils.getAccounts,
  ensureAccountBinding: accountUtils.ensureAccountBinding,
  withAutoRefresh: accountUtils.withAutoRefresh,
  makeRequest: skportApi.makeRequest,
};

const tw = createTranslator("tw");
const AK = { gameId: 1, uid: "515336528", nickName: "AK", channelMasterId: "6", roles: [], defaultRole: null };
const EF = { gameId: 3, uid: "837903459", nickName: "", channelMasterId: "6", roles: [], defaultRole: null };

async function main() {
  const events: string[] = [];
  let accounts: any[] = [];
  const requests: any[] = [];
  const refreshed: any[] = [];

  accountUtils.getAccounts = async () => {
    events.push("getAccounts");
    return accounts;
  };
  accountUtils.ensureAccountBinding = async () => {
    events.push("ensureAccountBinding");
  };
  accountUtils.withAutoRefresh = async (_c: any, _u: string, account: any, action: any) => {
    events.push("withAutoRefresh");
    refreshed.push(account);
    return action("cred", "salt", { onStale: async () => true, locale: "tw" });
  };
  skportApi.makeRequest = async (_m: string, _url: string, options: any) => {
    events.push("makeRequest");
    requests.push(options);
    return {
      code: 0,
      data: { indieHard: { indieHardGroups: [{ activityName: "Season 1", mock: true }] } },
    };
  };

  // The card drawing is not under test; keep it from needing real group data.
  require("../../utils/indieHardCanvasUtils").buildIndieHardCard = async () =>
    Buffer.from("png");
  const command = require("./indieHard").default;

  const chat = (opts: Record<string, string>) => {
    const replies: any[] = [];
    const interaction: any = {
      locale: "zh-TW",
      user: { id: "U" },
      isStringSelectMenu: () => false,
      isChatInputCommand: () => true,
      options: { getString: (n: string) => opts[n] ?? null },
      deferReply: async () => void events.push("deferReply"),
      editReply: async (p: any) => {
        events.push("editReply");
        replies.push(p);
      },
    };
    return { interaction, replies };
  };
  const text = (payload: any) => JSON.stringify(payload);

  try {
    // Zero accounts: acknowledged first, localized message, no network.
    accounts = [];
    {
      events.length = 0;
      const { interaction, replies } = chat({});
      await command.execute({}, interaction, tw, {});
      assert.equal(events[0], "deferReply", "defer before any account lookup");
      assert.ok(text(replies[0]).includes(tw("indieHard_NoAccount")));
      assert.ok(!events.includes("makeRequest"));
    }

    // Arknights-only account: its own message, no request for an Arknights role.
    accounts = [{ info: { id: "ak" }, roles: [AK] }];
    {
      events.length = 0;
      const { interaction, replies } = chat({});
      await command.execute({}, interaction, tw, {});
      assert.equal(events[0], "deferReply");
      assert.ok(text(replies[0]).includes(tw("indieHard_NoEndfieldRole")));
      assert.ok(!events.includes("makeRequest"));
    }

    // Unknown account index.
    accounts = [{ info: { id: "ak" }, roles: [AK] }, { info: { id: "both" }, roles: [AK, EF] }];
    {
      events.length = 0;
      const { interaction, replies } = chat({ account: "7" });
      await command.execute({}, interaction, tw, {});
      assert.ok(text(replies[0]).includes(tw("indieHard_AccountNotFound")));
    }

    // Default picks the first account with an Endfield role; request goes through
    // withAutoRefresh (so onStale is wired) with the Endfield role, not the Arknights one.
    {
      events.length = 0;
      const { interaction } = chat({});
      await command.execute({}, interaction, tw, {});
      assert.equal(events[0], "deferReply", "defer is the first thing that happens");
      const firstNetwork = events.findIndex((e) => ["ensureAccountBinding", "withAutoRefresh", "makeRequest"].includes(e));
      assert.ok(firstNetwork > 0);
      assert.equal(refreshed[refreshed.length - 1], accounts[1]);
      const req = requests[requests.length - 1];
      assert.equal(req.params.roleId, "837903459");
      assert.equal(req.params.serverId, "6");
      assert.equal(req.params.userId, "837903459", "same userId parameter as before: the binding uid");
      assert.equal(typeof req.onStale, "function");
    }

    // Explicit account: the other (Arknights-only) one is refused, not silently replaced.
    {
      events.length = 0;
      const { interaction, replies } = chat({ account: "0" });
      await command.execute({}, interaction, tw, {});
      assert.ok(text(replies[0]).includes(tw("indieHard_NoEndfieldRole")));
    }

    // Select menu: deferUpdate first; reads the cache of the account in the customId.
    {
      events.length = 0;
      const replies: any[] = [];
      const sel: any = {
        locale: "zh-TW",
        user: { id: "U" },
        customId: "影拓豐碑:select:U:1",
        values: ["0"],
        isStringSelectMenu: () => true,
        deferUpdate: async () => void events.push("deferUpdate"),
        editReply: async (p: any) => {
          events.push("editReply");
          replies.push(p);
        },
      };
      await command.execute({}, sel, tw, {});
      assert.equal(events[0], "deferUpdate");
      assert.equal(events.filter((e) => e === "makeRequest").length, 0, "served from cache");
      assert.equal(replies.length, 1);
      // wrong account in the id -> expired notice, not a crash
      events.length = 0;
      replies.length = 0;
      sel.customId = "影拓豐碑:select:U:0";
      await command.execute({}, sel, tw, {});
      assert.equal(events[0], "deferUpdate");
      assert.ok(text(replies[0]).includes(tw("indieHard_DataExpired")));
    }

    console.log("indieHard checks passed");
  } finally {
    Object.assign(accountUtils, {
      getAccounts: originals.getAccounts,
      ensureAccountBinding: originals.ensureAccountBinding,
      withAutoRefresh: originals.withAutoRefresh,
    });
    skportApi.makeRequest = originals.makeRequest;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
