import assert from "node:assert/strict";
import { createTranslator } from "../../utils/i18n";

const accountUtils = require("../../utils/accountUtils");
const attendanceUtils = require("../../utils/attendanceUtils");
const canvas = require("../../utils/dailyCanvasUtils");
const originals = {
  getAccounts: accountUtils.getAccounts,
  ensureAccountBinding: accountUtils.ensureAccountBinding,
  withAutoRefresh: accountUtils.withAutoRefresh,
  processRoleAttendance: attendanceUtils.processRoleAttendance,
  buildDailyAttendanceCard: canvas.buildDailyAttendanceCard,
};

const tw = createTranslator("tw");
const AK = { gameId: 1, uid: "515336528", nickName: "AK", channelMasterId: "6", roles: [], defaultRole: null };
const EF_NOROLE = { gameId: 3, uid: "837903459", nickName: "", channelMasterId: "6", roles: [], defaultRole: null };
const EF = { ...EF_NOROLE, roles: [{ roleId: "6600112233", serverId: "2", nickname: "Endmin", level: 30, serverName: "Asia" }] };

async function main() {
  const events: string[] = [];
  let accounts: any[] = [];
  const signed: any[] = [];
  let attendance: (role: any, gameId: number) => any = () => ({});

  accountUtils.getAccounts = async () => {
    events.push("getAccounts");
    return accounts;
  };
  accountUtils.ensureAccountBinding = async () => {};
  accountUtils.withAutoRefresh = async (_c: any, _u: string, _a: any, action: any) =>
    action("cred", "salt", {});
  attendanceUtils.processRoleAttendance = async (role: any, gameId: number) => {
    signed.push({ role, gameId });
    return attendance(role, gameId);
  };
  canvas.buildDailyAttendanceCard = async () => Buffer.from("png");
  const command = require("./daily").default;

  const run = async (sub: string, opts: Record<string, string> = {}) => {
    events.length = 0;
    signed.length = 0;
    const replies: any[] = [];
    const interaction: any = {
      locale: "zh-TW",
      user: { id: "U" },
      isChatInputCommand: () => true,
      options: {
        getSubcommand: () => sub,
        getString: (n: string) => opts[n] ?? null,
      },
      deferReply: async () => void events.push("deferReply"),
      editReply: async (p: any) => void replies.push(p),
      followUp: async (p: any) => void replies.push(p),
    };
    await command.execute({}, interaction, tw, {});
    return replies;
  };

  try {
    // Zero accounts: acknowledged first, localized message.
    accounts = [];
    {
      const replies = await run("claim");
      assert.equal(events[0], "deferReply");
      assert.equal(replies[0].content, tw("NoSetAccount"));
    }

    // A failed claim is never drawn as "already signed": it is a text line with the reason.
    accounts = [{ info: { id: "a" }, roles: [EF] }];
    attendance = () => ({ error: true, errorKind: "error", message: "HTTP 500 boom", nickname: "n" });
    {
      const replies = await run("claim", { game: "endfield" });
      assert.equal(signed.length, 1);
      assert.equal(signed[0].gameId, 3);
      assert.equal(signed[0].role.roleId, "6600112233", "the stored Endfield role is signed, never the binding uid");
      assert.equal(signed[0].role.serverId, "2");
      assert.ok(replies[0].content.startsWith("<@U>"));
      assert.ok(replies[0].content.includes("HTTP 500 boom"));
      assert.ok(!replies[0].files?.length, "no card for a failed request");
    }

    // Dead token: the localized token message, not a card.
    attendance = () => ({ error: true, errorKind: "token_expired", message: "x", nickname: "n" });
    {
      const replies = await run("claim", { game: "endfield" });
      assert.ok(replies[0].content.includes(tw("TokenExpired")));
      assert.ok(!replies[0].files?.length);
    }

    // Arknights-only account asked for Endfield: the clear "no Endfield character" message,
    // nothing is called.
    accounts = [{ info: { id: "a" }, roles: [AK] }];
    {
      const replies = await run("claim", { game: "endfield" });
      assert.equal(signed.length, 0);
      assert.equal(replies[0].content, tw("daily_NoEndfieldRole"));
    }

    // Endfield binding with no role (production: roles [] and no defaultRole): same message,
    // and no role is invented from the binding uid.
    accounts = [{ info: { id: "a" }, roles: [EF_NOROLE] }];
    {
      const replies = await run("check", { game: "endfield" });
      assert.equal(signed.length, 0);
      assert.equal(replies[0].content, tw("daily_NoEndfieldRole"));
    }

    // Asked for both on an account whose Endfield binding has no role: Arknights still runs,
    // the missing Endfield role is not an error line.
    accounts = [{ info: { id: "a" }, roles: [AK, EF_NOROLE] }];
    attendance = () => ({ signedNow: true, hasToday: true, nickname: "AK", totalDays: 3 });
    {
      const replies = await run("claim", { game: "both" });
      assert.deepEqual(signed.map((s) => s.gameId), [1]);
      assert.equal(replies[0].files.length, 1);
      assert.ok(!replies[0].content.includes(tw("daily_NoEndfieldRole")));
    }
    // Explicit Endfield on two accounts, only one has a role: the card plus a line for the other.
    accounts = [{ info: { id: "a", nickname: "NoRole" }, roles: [EF_NOROLE] }, { info: { id: "b" }, roles: [EF] }];
    {
      const replies = await run("claim", { game: "endfield" });
      assert.deepEqual(signed.map((s) => s.gameId), [3]);
      assert.ok(replies[0].content.includes(String(tw("daily_NoEndfieldRole")).replace(/^❌s*/, "")));
      assert.ok(replies[0].content.includes("NoRole"));
    }

    // Mixed account, both games: one success card plus one error line.
    accounts = [{ info: { id: "a" }, roles: [AK, EF] }];
    attendance = (_r: any, gameId: number) =>
      gameId === 1
        ? { signedNow: true, hasToday: true, nickname: "AK", totalDays: 3 }
        : { error: true, errorKind: "error", message: "nope", nickname: "EF" };
    {
      const replies = await run("claim", { game: "both" });
      assert.deepEqual(signed.map((s) => s.gameId), [1, 3]);
      assert.equal(replies[0].files.length, 1);
      assert.ok(replies[0].content.includes("nope"));
    }

    console.log("daily checks passed");
  } finally {
    Object.assign(accountUtils, {
      getAccounts: originals.getAccounts,
      ensureAccountBinding: originals.ensureAccountBinding,
      withAutoRefresh: originals.withAutoRefresh,
    });
    attendanceUtils.processRoleAttendance = originals.processRoleAttendance;
    canvas.buildDailyAttendanceCard = originals.buildDailyAttendanceCard;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
