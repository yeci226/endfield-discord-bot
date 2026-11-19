import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { AttachmentBuilder, MessageFlags } from "discord.js";
import { loadImage } from "@napi-rs/canvas";
import {
  cleanNewsTitle,
  selectTraditionalNews,
  SkportNewsService,
} from "../services/SkportNewsService";
import {
  buildCardMessages,
  deliverCardMessage,
  sendCardOnOwningCluster,
} from "./cardNotification";
import {
  drawPlayerCard,
  profileSections,
  publicProfileDetail,
  progressText,
  roomOperatorName,
  layoutPlayerCards,
} from "./playerCards";
import {
  findProfileAccount,
  profilePayload,
  profileNavigation,
} from "./profileView";
import {
  defaultReminder,
  evaluateReminder,
  nextDailyReset,
  reminderKey,
  reminderSections,
  reminderStateKey,
  reminderTargets,
  validateReminder,
} from "./reminders";
import { reminderWizard } from "./reminderWizard";
import { MonitorService } from "../services/MonitorService";
import { CustomDatabase } from "./Database";
import { createTranslator } from "./i18n";

const now = Date.parse("2026-09-07T18:00:00Z");
const detail: any = {
  base: {
    name: "測試管理員",
    roleId: "2002",
    serverName: "Asia",
    saveTime: String(now / 1000),
    avatarUrl: "",
    level: 60,
    worldLevel: 5,
    mainMission: { description: "測試主線" },
  },
  config: {
    charSwitch: true,
    standingsSwitch: true,
    modules: [
      "CHAR",
      "REALTIME",
      "ACHIEVE",
      "DOMAIN_BUILD",
      "DOMAIN_EXPLORE",
      "SPACESHIP",
      "WAR_ECHOES",
      "INDIE_HARD",
      "CRISIS_CONTRACT",
    ].map((id) => ({ id: "MODULE_" + id, switch: true })),
  },
  chars: [],
  dungeon: {
    curStamina: "225",
    maxStamina: "240",
    maxTs: String((now + 45 * 60000) / 1000),
  },
  dailyMission: { dailyActivation: 60, maxDailyActivation: 100 },
  weeklyMission: { score: 3, total: 5 },
  bpSystem: { curLevel: 32, maxLevel: 60 },
  seekSuspicion: { count: 8, total: 12 },
  domain: [
    {
      domainId: "1",
      name: "四號谷地",
      level: 5,
      moneyMgr: { count: 5000, total: 10000 },
      settlements: [
        {
          id: "s1",
          name: "樞紐區據點",
          level: 4,
          remainMoney: "1200",
          moneyMax: "3000",
          exp: "700",
          expToLevelUp: "1000",
        },
      ],
      levels: [
        {
          levelId: "l1",
          name: "樞紐區",
          puzzleCount: { count: 8, total: 10 },
          trchestCount: { count: 32, total: 40 },
          pieceCount: { count: 5, total: 7 },
        },
      ],
    },
    { domainId: "2", name: "武陵", settlements: [], levels: [] },
  ],
  spaceShip: {
    rooms: [
      { id: "r1", type: 0, level: 4, chars: [] },
      {
        id: "r2",
        type: 1,
        level: 3,
        chars: [{ charId: "測試幹員", physicalStrength: 86, favorability: 50 }],
      },
    ],
  },
  crisisContract: [
    { id: "c1", name: "危機合約測試賽季", highest: 36, challengeCount: 5 },
  ],
  warEchoes: { seasons: [{ id: "w1", name: "戰鬥回響測試賽季", stars: 12 }] },
  indieHard: {
    indieHardGroups: [
      {
        id: "i1",
        name: "蝕像尋遺",
        dungeonGroups: [
          {
            normalDungeon: { name: "試煉關卡", isPass: true },
            hardDungeon: { isPass: false },
          },
        ],
      },
    ],
  },
  achieve: {
    count: 1,
    achieveMedals: [
      {
        achievementData: { name: "探索的起點", cateName: "區域探索" },
        level: 1,
        isPlated: false,
        obtainTs: String(now / 1000),
      },
    ],
  },
};
const accounts = [
  {
    info: { id: "1001", nickname: "第一個帳號" },
    roles: [{ gameId: 1, roles: [{ roleId: "2001", serverId: "1" }] }],
  },
  {
    info: { id: "1002", nickname: "第二個帳號" },
    roles: [
      {
        gameId: 3,
        roles: [{ roleId: "2002", serverId: "2", nickname: "測試管理員" }],
      },
    ],
  },
];
const json = (p: any) => JSON.parse(JSON.stringify(p));
async function main() {
  const mixed = [
    "ja_JP",
    "zh_Hant",
    "ja_JP",
    "zh_Hant",
    undefined,
    "zh_Hant",
    "zh_Hant",
  ].map((resourceLocale, id) => ({
    item: { id, resourceLocale, pubLocale: "zh_Hant" },
  }));
  assert.deepEqual(
    selectTraditionalNews(mixed).map((n) => n.item.id),
    [5, 3, 1],
  );
  assert.deepEqual(
    selectTraditionalNews(mixed, true).map((n) => n.item.id),
    [1],
  );
  assert.equal(cleanNewsTitle("🎁「標題」"), "「標題」");
  assert.equal(cleanNewsTitle("句中 🎁  Emoji 👩‍💻 測試"), "句中 Emoji 測試");
  assert.equal(cleanNewsTitle("🎁🇹🇼1️⃣"), "Endfield News");
  assert.equal(cleanNewsTitle("[文字]"), "\\[文字\\]");
  const news = new SkportNewsService({} as any);
  const newsPayload = (news as any).buildPayload(
    {
      item: {
        id: "1",
        timestamp: "1788800000",
        caption: [{ kind: "text", text: { text: "內文 🎁 保留" } }],
      },
      user: { nickname: "Official" },
    },
    "🎁「標題」",
  );
  assert.ok(JSON.stringify(newsPayload).includes("內文 🎁 保留"));
  assert.ok(JSON.stringify(newsPayload).includes("[「標題」]"));
  const messages = buildCardMessages(
    [
      {
        files: Array.from(
          { length: 19 },
          (_, i) =>
            new AttachmentBuilder(Buffer.from("image"), {
              name: `daily-${i}.png`,
            }),
        ),
      },
    ],
    "<@99>",
  );
  assert.deepEqual(
    messages.map((m) => m.files.length),
    [8, 8, 3],
  );
  for (const message of messages) {
    const galleries = json(message).components[0].components.filter(
      (c: any) => c.type === 12,
    );
    assert.equal(galleries.length, message.files.length);
    assert.ok(galleries.every((g: any) => g.items.length === 1));
  }
  let sent: any;
  const remoteClient: any = {
    channels: {
      cache: new Map([
        [
          "123",
          {
            send: async (p: any) => {
              sent = p;
            },
          },
        ],
      ]),
    },
    guilds: { cache: new Map() },
  };
  // Simulate the exact callback serialization used by hybrid sharding (no TS helpers in scope).
  const isolatedCallback = vm.runInNewContext(
    "(" + sendCardOnOwningCluster.toString() + ")",
    { Buffer, require },
  );
  await deliverCardMessage(
    {
      channels: { cache: new Map() },
      guilds: { cache: new Map() },
      cluster: {
        broadcastEval: async (_fn: any, { context }: any) => [
          await isolatedCallback(remoteClient, context),
        ],
      },
    } as any,
    "99",
    { notify_method: "channel", channelId: "123" },
    messages[0],
  );
  assert.equal(sent.flags, MessageFlags.IsComponentsV2);
  assert.equal(
    sent.components[0].components.filter((c: any) => c.type === 12).length,
    8,
  );
  assert.equal(sent.files[0].attachment.toString(), "image");
  const target = reminderTargets(accounts)[0];
  assert.equal(target.uid, "1002");
  assert.equal(
    findProfileAccount(accounts, { ownerId: "99", ...target }),
    accounts[1],
  );
  assert.equal(
    findProfileAccount(accounts, { ownerId: "99", ...target, roleId: "9999" }),
    undefined,
  );
  assert.equal(progressText(undefined, undefined), "— / —");
  const privateDetail = { ...detail, config: { modules: [] } };
  const privateSafe = publicProfileDetail(privateDetail);
  assert.equal(privateSafe.dungeon, undefined);
  assert.equal(privateSafe.achieve, undefined);
  assert.equal(privateSafe.spaceShip, undefined);
  assert.ok(
    !JSON.stringify(profileSections(privateSafe, 2, "tw")).includes("1200"),
  );
  assert.ok(
    !JSON.stringify(profileSections(privateSafe, 4, "tw")).includes(
      "探索的起點",
    ),
  );
  const medalPayload = json(
    await profilePayload(
      { db: { get: async () => undefined } } as any,
      { ...target, ownerId: "99" },
      detail,
      createTranslator("tw"),
      4,
    ),
  );
  const ids = medalPayload.components[0].components
    .flatMap((c: any) => c.components || [])
    .map((c: any) => c.custom_id);
  assert.equal(new Set(ids).size, ids.length);
  const mapped = {
    ...detail,
    chars: [
      {
        id: "hash-id",
        charData: {
          id: "hash-id",
          name: "萊萬汀",
          avatarSqUrl: "https://static.skport.com/image/operator.png?size=80",
        },
      },
    ],
  };
  const roomChar = {
    charId: "chr_0016_laevat",
    avatarUrl: "https://static.skport.com/image/operator.png?size=120",
  };
  assert.equal(roomOperatorName(mapped, roomChar, "tw"), "萊萬汀");
  assert.equal(
    roomOperatorName(
      { ...mapped, chars: [...mapped.chars, ...mapped.chars] },
      roomChar,
      "tw",
    ),
    "名稱未提供",
  );
  assert.equal(
    roomOperatorName({ ...mapped, config: { modules: [] } }, roomChar, "tw"),
    "名稱未提供",
  );
  assert.equal(roomOperatorName(mapped, { charId: "hash-id" }, "tw"), "萊萬汀");
  assert.equal(
    roomOperatorName(mapped, { charId: "missing" }, "en"),
    "Name unavailable",
  );
  const sections = [1, 2, 3].map((n) => ({
    title: `section${n}`,
    rows: Array.from({ length: n }, (_, i) => ({ label: `row${n}-${i}` })),
  }));
  const balanced = layoutPlayerCards(sections)[0].placements;
  assert.equal(
    balanced.find((p) => p.section.title === "section1")!.x,
    balanced.find((p) => p.section.title === "section2")!.x,
  );
  assert.ok(
    balanced.find((p) => p.section.title === "section3")!.x > balanced[0].x,
  );
  const leftBottom = Math.max(
    ...balanced.filter((p) => p.x === balanced[0].x).map((p) => p.y + p.height),
  );
  const rightBottom = Math.max(
    ...balanced.filter((p) => p.x !== balanced[0].x).map((p) => p.y + p.height),
  );
  assert.equal(leftBottom, rightBottom);
  const overflow = sections.map((s) => ({
    ...s,
    rows: Array.from({ length: 50 }, (_, i) => ({
      label: `${s.title}-${i}`,
      cells: [
        {
          label: "長名稱 / Long operator name",
          value: "0 / 0",
          icon: "asset:missing",
          portrait: true,
        },
      ],
    })),
  }));
  const layouts = layoutPlayerCards(overflow);
  assert.ok(layouts.length > 1);
  assert.deepEqual(
    layouts
      .flatMap((p) =>
        p.placements.flatMap((s) => s.section.rows.map((r) => r.label)),
      )
      .sort(),
    overflow.flatMap((s) => s.rows.map((r) => r.label)).sort(),
  );
  for (const layout of layouts) {
    assert.ok(layout.height <= 1800);
    for (const p of layout.placements) {
      assert.ok(p.y + p.height <= layout.height);
      assert.ok(
        !layout.placements.some(
          (q) =>
            q !== p &&
            p.x === q.x &&
            p.y < q.y + q.height &&
            q.y < p.y + p.height,
        ),
      );
    }
  }
  assert.deepEqual(profileNavigation("sheet2_1_3"), {
    page: 2,
    index: 1,
    sheet: 3,
  });
  assert.deepEqual(profileNavigation("domain", "1"), {
    page: 2,
    index: 1,
    sheet: 0,
  });
  assert.throws(() => profileNavigation("sheet2_1_-1"));
  const overflowDetail = {
    ...detail,
    domain: [
      {
        ...detail.domain[0],
        levels: Array.from({ length: 40 }, (_, i) => ({
          ...detail.domain[0].levels[0],
          name: `區域 ${i}`,
        })),
      },
    ],
  };
  const overflowPayload = json(
    await profilePayload(
      { db: { get: async () => undefined } } as any,
      { ...target, ownerId: "99" },
      overflowDetail,
      createTranslator("tw"),
      2,
    ),
  );
  const overflowIds = overflowPayload.components[0].components
    .flatMap((c: any) => c.components || [])
    .map((c: any) => c.custom_id);
  assert.ok(
    overflowIds.some((id: string) => id?.startsWith("profile:sheet2_0_1:")),
  );
  assert.equal(new Set(overflowIds).size, overflowIds.length);
  assert.ok(overflowIds.every((id: string) => !id || id.length <= 100));
  const image = await loadImage(
    Buffer.from(overflowPayload.files[0].attachment.data),
  );
  assert.ok(image.height <= image.width * 1.25);
  const config = { ...defaultReminder("99", target, detail), enabled: true };
  assert.equal(
    defaultReminder("99", target, detail, { stamina_notify: true }).enabled,
    false,
  );
  validateReminder(config, detail);
  assert.throws(() =>
    validateReminder({ ...config, sanity: "amount", value: 241 }, detail),
  );
  assert.throws(() => validateReminder({ ...config, value: 14 }, detail));
  assert.equal(nextDailyReset(now, 8), Date.parse("2026-09-07T20:00:00Z"));
  assert.equal(nextDailyReset(now, -5), Date.parse("2026-09-08T09:00:00Z"));
  assert.equal(
    nextDailyReset(Date.parse("2026-09-07T20:00:00Z"), 8),
    Date.parse("2026-09-08T20:00:00Z"),
  );
  const first = evaluateReminder(config, {}, detail, now);
  assert.ok(first.sanity && first.daily);
  const delivered = {
    revision: config.revision,
    sanitySent: true,
    dailyCycle: first.reset,
  };
  assert.equal(evaluateReminder(config, delivered, detail, now).sanity, false);
  assert.equal(evaluateReminder(config, delivered, detail, now).daily, false);
  const full = {
    ...detail,
    dungeon: { ...detail.dungeon, curStamina: "240", maxTs: "0" },
  };
  assert.equal(evaluateReminder(config, {}, full, now).sanity, true);
  assert.equal(
    evaluateReminder(
      config,
      {},
      {
        ...detail,
        dungeon: { ...detail.dungeon, maxTs: String(now / 1000 - 60) },
      },
      now,
    ).sanity,
    true,
  );
  const spent = {
    ...detail,
    dungeon: {
      ...detail.dungeon,
      curStamina: "100",
      maxTs: String((now + 300 * 60000) / 1000),
    },
  };
  const rearmed = evaluateReminder(config, delivered, spent, now);
  assert.equal(rearmed.state.sanitySent, false);
  assert.equal(evaluateReminder(config, rearmed.state, full, now).sanity, true);
  assert.equal(
    evaluateReminder(config, delivered, { ...detail, dungeon: undefined }, now)
      .state.sanitySent,
    true,
  );
  assert.equal(
    evaluateReminder(config, {}, { ...detail, dailyMission: undefined }, now)
      .daily,
    false,
  );
  assert.equal(
    evaluateReminder(
      config,
      { revision: config.revision, retryAt: now + 3600000 },
      detail,
      now,
    ).sanity,
    false,
  );

  const db = new CustomDatabase(":memory:");
  await db.set("monitorConfig", {
    "99": { stamina_notify: true, mission_notify: true, notify_method: "dm" },
  });
  await db.set("99.accounts", accounts);
  const accountUtils = require("./accountUtils"),
    skport = require("./skportApi");
  const originals = [
    accountUtils.getAccounts,
    accountUtils.withAutoRefresh,
    skport.getCardDetail,
    Date.now,
  ];
  let notificationCount = 0,
    failure: any = { code: 50007 };
  try {
    accountUtils.getAccounts = async () => accounts;
    accountUtils.withAutoRefresh = async (
      _c: any,
      _u: any,
      _a: any,
      request: any,
    ) => request("", "", {});
    skport.getCardDetail = async () => ({ code: 0, data: { detail: full } });
    Date.now = () => now;
    const client: any = {
      db,
      cluster: { id: 0 },
      isReady: () => true,
      users: {
        fetch: async () => ({
          send: async () => {
            if (failure) throw failure;
            notificationCount++;
          },
        }),
      },
    };
    const service = new MonitorService(client);
    await service.runMonitoring();
    assert.equal(
      notificationCount,
      0,
      "A legacy monitorConfig alone sends nothing: only reminder.v2 rules (created by the startup migration) can notify",
    );
    await db.set(reminderKey(config), config);
    await service.runMonitoring();
    assert.ok((await db.get(reminderStateKey(config))).disabledReason);
    assert.equal(
      (await db.get(reminderStateKey(config))).sanitySent,
      undefined,
    );
    await db.set(reminderStateKey(config), {});
    failure = { code: 503 };
    await service.runMonitoring();
    assert.ok((await db.get(reminderStateKey(config))).retryAt > now);
    await db.set(reminderStateKey(config), {});
    failure = null;
    await service.runMonitoring();
    await service.runMonitoring();
    assert.equal(notificationCount, 1, "Both triggers merge and do not repeat");

    let screen: any;
    const interaction: any = {
      user: { id: "99" },
      isChatInputCommand: () => true,
      deferReply: async () => {},
      deferUpdate: async () => {},
      editReply: async (p: any) => {
        screen = json(p);
      },
      followUp: async (p: any) => {
        throw new Error(p.content);
      },
      reply: async () => {},
    };
    await reminderWizard(client, interaction, "tw");
    const token =
      screen.components[0].components[1].components[0].custom_id.split(":")[1];
    interaction.isChatInputCommand = () => false;
    interaction.customId = `reminder:${token}:account`;
    interaction.values = ["1002"];
    await reminderWizard(client, interaction, "tw");
    const roleValue =
      screen.components[0].components[1].components[0].options[0].value;
    const sessionKey = `reminderWizard.session.v1.${token}`;
    const staleSession = await db.get(sessionKey);
    delete staleSession.uid;
    staleSession.page = "home";
    await db.set(sessionKey, staleSession);
    interaction.customId = `reminder:${token}:role`;
    interaction.values = [roleValue];
    let roleSelectionError: any;
    try {
      await reminderWizard(client, interaction, "tw");
    } catch (error) {
      roleSelectionError = error;
    }
    assert.equal(
      roleSelectionError,
      undefined,
      "a displayed role option must resolve even when the selected-account context is stale",
    );
    for (const action of ["sanity", "daily", "review", "save"] as const) {
      interaction.customId = `reminder:${token}:${action}`;
      interaction.values = [];
      await reminderWizard(client, interaction, "tw");
    }
    assert.equal((await db.get(reminderKey(config))).uid, "1002");
    assert.equal((await db.get(reminderKey(config))).enabled, true);
    assert.ok(await db.get("monitorConfig"));
  } finally {
    [
      accountUtils.getAccounts,
      accountUtils.withAutoRefresh,
      skport.getCardDetail,
      Date.now,
    ] = originals;
  }

  const output = process.argv[2];
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    for (const lang of ["tw", "en"]) {
      for (const page of [2, 3, 4])
        fs.writeFileSync(
          path.join(output, `profile-${page}-${lang}.webp`),
          await drawPlayerCard(
            detail,
            lang === "tw"
              ? ["", "", "建設與探索", "進度與勳章", "勳章收藏"][page]
              : "Player profile",
            profileSections(detail, page, lang),
            lang,
            now,
          ),
        );
      fs.writeFileSync(
        path.join(output, `reminder-${lang}.webp`),
        await drawPlayerCard(
          detail,
          lang === "tw" ? "理智與每日任務提醒" : "Sanity & daily reminder",
          reminderSections(config, detail, first, lang),
          lang,
          now,
        ),
      );
    }
  }
  console.log(
    "SKPORT checks passed: language/title, gallery serialization, privacy/account routing, reminder wizard/delivery/reset/rearm.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
