import assert from "node:assert/strict";

const accountUtils = require("./accountUtils") as {
  ensureAccountBinding: (...args: any[]) => Promise<boolean>;
};
const originalEnsureAccountBinding = accountUtils.ensureAccountBinding;
let bindingRefreshCalls = 0;
accountUtils.ensureAccountBinding = async () => {
  bindingRefreshCalls++;
  return false;
};

const gachaCommand = require("../commands/general/gacha").default;
const userId = "123456789012345678";
const account = {
  info: { id: "account-test" },
  roles: [
    {
      gameId: 3,
      uid: "binding-uid",
      roles: [{ roleId: "7392", nickname: "羽冰" }],
    },
  ],
};
const literalPrefixes: string[] = [];
const legacyPrefixes: string[] = [];
const db: any = {
  get: async (key: string) =>
    key === `${userId}.accounts` ? [account] : null,
  findFieldByPrefix: (prefix: string) => {
    legacyPrefixes.push(prefix);
    return [];
  },
  findFieldByGlobPrefix: (prefix: string, jsonPath: string) => {
    assert.equal(jsonPath, "$.info.nickname");
    literalPrefixes.push(prefix);
    return [
      {
        id: `${prefix}1700000000000`,
        field: "我的訪客紀錄",
      },
    ];
  },
};

async function runAutocomplete(focused: string) {
  let result: Array<{ name: string; value: string }> = [];
  const interaction: any = {
    locale: "zh-TW",
    user: { id: userId },
    options: {
      getSubcommand: () => "load",
      getFocused: () => focused,
      get: () => undefined,
    },
    respond: async (choices: Array<{ name: string; value: string }>) => {
      result = choices;
    },
  };
  await gachaCommand.autocomplete({}, interaction, db);
  return result;
}

async function main() {
  try {
    const byName = await runAutocomplete("羽冰");
    const byUid = await runAutocomplete("7392");

    assert.equal(
      bindingRefreshCalls,
      0,
      "autocomplete must use cached account bindings, not perform refresh/API work",
    );
    assert.deepEqual(
      legacyPrefixes,
      [],
      "autocomplete must not scan every user's gacha log record",
    );
    assert.deepEqual(literalPrefixes, [
      `GACHA_LOG_EF_GUEST_${userId}_`,
      `GACHA_LOG_EF_GUEST_${userId}_`,
    ]);
    assert.deepEqual(byName, [{ name: "羽冰 (7392)", value: "EF_7392" }]);
    assert.deepEqual(byUid, [{ name: "羽冰 (7392)", value: "EF_7392" }]);
    console.log("gacha autocomplete latency regression tests passed");
  } finally {
    accountUtils.ensureAccountBinding = originalEnsureAccountBinding;
  }
}

void main();
