import { ExtendedClient } from "../structures/Client";
import axios from "axios";
import crypto from "crypto";
import {
  TextChannel,
  NewsChannel,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} from "discord.js";
import { Logger } from "../utils/Logger";
import {
  DispatchRecord,
  FeedItem,
  ItemWork,
  MAX_ITEMS_PER_POLL,
  NEWS_DISPATCH_PREFIX,
  NewsSub,
  dispatchKey,
  dispatchSuffix,
  failedDispatchRecord,
  isPermanentSendError,
  listNewsSubs,
  migrateNewsSubscriptions,
  nextSubscriptionState,
  selectItemsToDispatch,
  shouldBaselineSkip,
  subKeyOf,
  sweepNewsDispatch,
} from "../utils/newsSubscriptions";

import {
  formatAcceptLanguage,
  formatSkLanguage,
  makeRequest,
} from "../utils/skportApi";

const SKPORT_API_URL =
  "https://zonai.skport.com/web/v1/home/index?pageSize=10&sortType=2&gameId=3&cateId=1006";
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

interface SkportNewsItem {
  item: {
    id: string;
    title: string;
    resourceLocale?: string;
    pubLocale?: string;
    caption: Array<{
      kind: string;
      text?: { text: string };
      link?: { link: string; text: string };
    }>;
    shareLink: string;
    timestamp: string;
    cover?: { url: string };
    album?: Array<{ image: { url: string } }>;
  };
  user: {
    nickname: string;
    avatar: string;
  };
}

export function selectTraditionalNews<T extends { item?: { resourceLocale?: string } }>(items: T[], force = false, limit = 3): T[] {
  return items.filter((news) => news?.item?.resourceLocale === "zh_Hant")
    .slice(0, force ? 1 : limit).reverse();
}

export function cleanNewsTitle(title: string): string {
  // Property escapes via RegExp keep the project's ES6 compilation target.
  const clean = title.replace(new RegExp("[0-9#*]\\uFE0F?\\u20E3|[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\p{Emoji_Modifier}\\uFE0E\\uFE0F\\u200D\\u{E0020}-\\u{E007F}]", "gu"), "")
    .replace(/\s+/g, " ").trim() || "Endfield News";
  return clean.replace(/[\\\[\]*_`~]/g, "\\$&");
}

/** One unit of guild delivery handed to a cluster (plain data: it crosses processes). */
export interface ClusterNewsWork {
  suffix: string;
  guildId: string;
  channelId: string;
  action: "send" | "edit";
  messageId?: string;
}

export interface ClusterNewsResult {
  suffix: string;
  ok: boolean;
  messageId?: string;
  code?: number;
  message?: string;
  /** The broadcast itself failed: nothing is known about this delivery, so it must not use up a retry. */
  skip?: boolean;
}

/**
 * Runs inside broadcastEval on every cluster, so it must be self-contained
 * (no imports, no module-level helpers). Promise chains are used on purpose, as
 * in cardNotification: the ES6 build target compiles async functions to a
 * helper that may not exist in the evaluated context. A test runs the
 * stringified function in a bare vm context to keep this true.
 * Each cluster only answers for guilds it owns.
 */
export function deliverNewsOnCluster(
  c: any,
  ctx: { payload: any; work: ClusterNewsWork[] },
): Promise<ClusterNewsResult[]> {
  const out: ClusterNewsResult[] = [];
  return ctx.work
    .reduce(
      (chain: Promise<unknown>, w: ClusterNewsWork) =>
        chain.then(() => {
          if (!c.guilds.cache.has(w.guildId)) return undefined;
          const channel = c.channels.cache.get(w.channelId);
          if (!channel || typeof channel.send !== "function") {
            out.push({ suffix: w.suffix, ok: false, code: 10003 });
            return undefined;
          }
          const op: Promise<string> =
            w.action === "edit"
              ? Promise.resolve(channel.messages.fetch(w.messageId)).then(
                  (m: any) => Promise.resolve(m.edit(ctx.payload)).then(() => String(w.messageId)),
                )
              : Promise.resolve(channel.send(ctx.payload)).then((m: any) => String(m.id));
          return op.then(
            (messageId) => {
              out.push({ suffix: w.suffix, ok: true, messageId });
            },
            (e: any) => {
              out.push({
                suffix: w.suffix,
                ok: false,
                code: e && e.code ? Number(e.code) : undefined,
                message: String((e && e.message) || e),
              });
            },
          );
        }),
      Promise.resolve(),
    )
    .then(() => out);
}

const BASELINE_MARKER = "news.baseline.v1";
const GUILD_CHUNK = 50;

export function newsItemHash(news: SkportNewsItem): string {
  const contentString =
    JSON.stringify(news.item.caption) +
    (news.item.title || "") +
    (news.item.cover?.url || "");
  return crypto.createHash("md5").update(contentString).digest("hex");
}

function newsItemTitle(news: SkportNewsItem): string {
  const title = news.item.title;
  if (title && title.trim() !== "") return title;
  const firstText = (news.item.caption || []).find(
    (b) => b.kind === "text" && b.text && b.text.text.trim().length > 0,
  );
  return firstText
    ? firstText.text!.text.substring(0, 50) +
        (firstText.text!.text.length > 50 ? "..." : "")
    : "Endfield News";
}

export class SkportNewsService {
  private client: ExtendedClient;
  private interval: NodeJS.Timeout | null = null;
  private isReady: boolean = false;
  private isPolling = false;
  private logger: Logger;
  /** Ids of the last successfully fetched, non-empty feed; null until then. */
  private lastFeedIds: Set<string> | null = null;
  private sweepCursor: string | null = null;

  constructor(client: ExtendedClient) {
    this.client = client;
    this.logger = new Logger("SkportNews");
  }

  /**
   * Primary cluster only: migrate the legacy subscription array first, then
   * start polling (so the first poll already sees the subscription rows), and
   * keep the dispatch table trimmed.
   */
  public register() {
    this.client.startup.onPrimary("news-service", async () => {
      try {
        const r = await migrateNewsSubscriptions(this.client.db);
        if (!r.skipped)
          this.logger.info(`Migrated ${r.migrated} news subscriptions to rows.`);
      } catch (error: any) {
        this.logger.error(`News subscription migration failed: ${error.message}`);
      }
      this.start();
    });
    this.client.startup.every("news-dispatch-retention", 60 * 60 * 1000, () =>
      this.pruneDispatch(),
    );
  }

  public start() {
    if (this.interval) return;
    this.logger.info("Skport News Service Started");
    void this.manualCheckNews();
    this.interval = setInterval(() => void this.manualCheckNews(), POLL_INTERVAL);
    this.isReady = true;
  }

  public stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Hourly: bounded batch of old `news_dispatch.*` rows. */
  public async pruneDispatch() {
    const r = await sweepNewsDispatch(this.client.db, {
      feedIds: this.lastFeedIds,
      cursor: this.sweepCursor,
      maxDelete: 2000,
      maxScan: 10_000,
    });
    this.sweepCursor = r.cursor;
    if (r.deleted > 0)
      this.logger.info(
        `Pruned ${r.deleted} old news_dispatch rows (scanned ${r.scanned}).`,
      );
  }

  public async manualCheckNews(force: boolean = false) {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      this.logger.info(
        `${force ? "Force checking" : "Checking"} for new Skport news...`,
      );

      const response = await makeRequest<any>("GET", SKPORT_API_URL, {
        headers: {
          authority: "zonai.skport.com",
          referer: "https://www.skport.com/", // News index uses www.skport.com still usually
        },
      });

      let newsList: SkportNewsItem[] | undefined;
      if (response && Array.isArray(response.list)) {
        newsList = response.list;
      } else if (
        response &&
        response.data &&
        Array.isArray(response.data.list)
      ) {
        newsList = response.data.list;
      }

      if (!newsList || (response.code !== undefined && response.code !== 0)) {
        this.logger.error(
          `Failed to fetch Skport news: ${response?.message || "Invalid response structure or no news found"}`,
        );
        return;
      }
      if (newsList.length > 0)
        this.lastFeedIds = new Set(
          newsList.map((n) => String(n?.item?.id)).filter(Boolean),
        );

      await this.processFeed(
        selectTraditionalNews(newsList, force, MAX_ITEMS_PER_POLL),
        force,
      );

      // 新聞處理完成後手動觸發垃圾回收 (GC)
      if (typeof global.gc === "function") {
        this.logger.info("Triggering manual garbage collection after news check...");
        global.gc();
      }
    } catch (error: any) {
      this.logger.error(`Error checking Skport news: ${error.message}`);
    } finally {
      this.isPolling = false;
    }
  }

  /** `items` are the feed's Traditional Chinese items, oldest first. */
  private async processFeed(items: SkportNewsItem[], force: boolean) {
    const db = this.client.db;
    const now = Date.now();
    const firstPoll = !(await db.get(BASELINE_MARKER));
    const subs = await listNewsSubs(db);

    const byId = new Map<string, SkportNewsItem>();
    const histories = new Map<string, any>();
    const records = new Map<string, DispatchRecord>();
    const feedItems: FeedItem[] = [];
    for (const news of items) {
      const id = String(news.item.id);
      const item: FeedItem = {
        id,
        timestampMs: parseInt(news.item.timestamp) * 1000,
        hash: newsItemHash(news),
      };
      const history = await db.get<any>(`news_history.${id}`);
      if (
        shouldBaselineSkip({ item, hasHistory: !!history, firstPoll, now })
      ) {
        // Never processed by the old code and already old: record it, do not post it.
        await db.set(`news_history.${id}`, {
          id,
          title: newsItemTitle(news),
          hash: item.hash,
          timestamp: now,
          complete: true,
        });
        continue;
      }
      if (!force && history?.complete && history.hash === item.hash) continue;
      byId.set(id, news);
      histories.set(id, history);
      feedItems.push(item);
      if (subs.length) {
        for (const row of await db.findByPrefix<DispatchRecord>(
          `${NEWS_DISPATCH_PREFIX}${id}.`,
        ))
          records.set(row.id, row.value);
      }
    }

    const picked = selectItemsToDispatch({
      items: feedItems,
      subs,
      getRecord: (item, sub) => records.get(dispatchKey(item.id, sub)) ?? null,
      historyChanged: (item) => {
        const h = histories.get(item.id);
        return !!h && h.hash !== item.hash;
      },
      force,
    });
    const pickedIds = new Set(picked.map((p) => p.item.id));

    for (const { item, work } of picked) {
      const news = byId.get(item.id)!;
      const title = newsItemTitle(news);
      this.logger.info(
        `${force ? "Force resending" : histories.get(item.id) ? "Delivering" : "New news found"}: ${title} (${item.id}) to ${work.length} subscription(s)`,
      );
      const outcomes = await this.deliver(this.buildPayload(news, title), work);
      let allOk = true;
      let sent = 0;
      for (const w of work) {
        const ok = await this.recordOutcome(item, w, outcomes.get(dispatchSuffix(w.sub)));
        allOk = allOk && ok;
        if (ok) sent++;
      }
      this.logger.info(`News ${item.id}: ${sent}/${work.length} delivered.`);
      await db.set(`news_history.${item.id}`, {
        id: item.id,
        title,
        hash: item.hash,
        timestamp: now,
        complete: allOk && !force,
      });
    }

    // Items that needed nothing are settled: later polls skip them without touching dispatch rows.
    if (!force) {
      for (const item of feedItems) {
        if (pickedIds.has(item.id)) continue;
        const news = byId.get(item.id)!;
        await db.set(`news_history.${item.id}`, {
          id: item.id,
          title: newsItemTitle(news),
          hash: item.hash,
          timestamp: histories.get(item.id)?.timestamp ?? now,
          complete: true,
        });
      }
    }
    if (firstPoll) await db.set(BASELINE_MARKER, { at: now });
  }

  /** Sends or edits `payload` for every work entry. Returns the outcome per dispatch suffix. */
  private async deliver(
    payload: any,
    work: ItemWork["work"],
  ): Promise<Map<string, ClusterNewsResult>> {
    const outcomes = new Map<string, ClusterNewsResult>();
    const guildWork: ClusterNewsWork[] = [];
    const dmWork: ItemWork["work"] = [];
    for (const w of work) {
      if (w.sub.guildId === "DM") dmWork.push(w);
      else
        guildWork.push({
          suffix: dispatchSuffix(w.sub),
          guildId: w.sub.guildId,
          channelId: w.sub.channelId,
          action: w.action,
          messageId: w.record?.messageId,
        });
    }

    for (let i = 0; i < guildWork.length; i += GUILD_CHUNK) {
      const chunk = guildWork.slice(i, i + GUILD_CHUNK);
      let perCluster: ClusterNewsResult[][] = [];
      let broadcastFailed = false;
      try {
        perCluster = await this.client.cluster.broadcastEval(deliverNewsOnCluster, {
          context: { payload, work: chunk },
        });
      } catch (error: any) {
        broadcastFailed = true;
        this.logger.error(`News broadcast failed: ${error.message}`);
      }
      for (const results of perCluster) {
        for (const r of results || []) outcomes.set(r.suffix, r);
      }
      for (const w of chunk) {
        // No cluster owns the guild/channel (or the broadcast failed): retry later, not a permanent error.
        if (!outcomes.has(w.suffix))
          outcomes.set(w.suffix, {
            suffix: w.suffix,
            ok: false,
            message: broadcastFailed ? "broadcast failed" : "no owner",
            // A failed broadcast says nothing about the channel: leave the item pending, free of charge.
            // "No owner" after a successful broadcast does count, so orphaned guilds settle.
            skip: broadcastFailed,
          });
      }
    }

    for (const w of dmWork) {
      const suffix = dispatchSuffix(w.sub);
      try {
        let messageId: string;
        if (w.action === "edit") {
          const channel: any = await this.client.channels.fetch(w.sub.channelId);
          const message = await channel.messages.fetch(w.record!.messageId!);
          await message.edit(payload);
          messageId = message.id;
        } else if (w.sub.userId) {
          messageId = (await this.client.users.send(w.sub.userId, payload)).id;
        } else {
          // Legacy row: only the DM channel id is known.
          const channel: any = await this.client.channels.fetch(w.sub.channelId);
          if (!channel || typeof channel.send !== "function")
            throw Object.assign(new Error("Unknown channel"), { code: 10003 });
          messageId = (await channel.send(payload)).id;
        }
        outcomes.set(suffix, { suffix, ok: true, messageId });
      } catch (e: any) {
        outcomes.set(suffix, {
          suffix,
          ok: false,
          code: e?.code ? Number(e.code) : undefined,
          message: String(e?.message || e),
        });
      }
    }
    return outcomes;
  }

  /** Persists one delivery outcome (dispatch row + subscription health). Returns true when delivered. */
  private async recordOutcome(
    item: FeedItem,
    w: ItemWork["work"][number],
    outcome: ClusterNewsResult | undefined,
  ): Promise<boolean> {
    const db = this.client.db;
    const now = Date.now();
    const key = dispatchKey(item.id, w.sub);
    const subKey = subKeyOf(w.sub);
    const base = {
      newsId: item.id,
      channelId: w.sub.channelId,
      guildId: w.sub.guildId,
      hash: item.hash,
    };
    if (outcome?.ok) {
      await db.set(key, {
        ...base,
        messageId: outcome.messageId,
        createdAt: w.record?.createdAt ?? now,
        delivered: true,
      } satisfies DispatchRecord);
      if (w.sub.failCount)
        db.update<NewsSub>(subKey, (cur) =>
          cur ? nextSubscriptionState(cur, null).sub : null,
        );
      return true;
    }

    if (outcome?.skip) return false;
    const code = outcome?.code;
    this.logger.warn(
      `News ${item.id} -> ${subKeyOf(w.sub)} failed (${code ?? "no code"}): ${outcome?.message ?? "unknown"}`,
    );
    if (isPermanentSendError(code)) {
      let removed = false;
      db.update<NewsSub>(subKey, (cur) => {
        if (!cur) return null;
        const next = nextSubscriptionState(cur, code);
        removed = next.remove;
        return next.remove ? null : next.sub;
      });
      if (removed)
        this.logger.warn(`Removed news subscription ${subKey} after repeated permanent errors.`);
    } else if (w.action === "edit") {
      // Editing is best effort: remember the new hash so it is not retried forever.
      await db.set(key, { ...(w.record || {}), hash: item.hash } as DispatchRecord);
    } else {
      await db.set(key, failedDispatchRecord(w.record, base, now));
    }
    return false;
  }

  private buildPayload(news: SkportNewsItem, title: string): any {
    const container = new ContainerBuilder();

    const author = news.user.nickname || "Official";
    const date = `<t:${Math.floor(parseInt(news.item.timestamp))}:f>`;
    const link = `https://www.skport.com/article?id=${news.item.id}`;

    // Clean title: Remove leading/trailing brackets to avoid Markdown link issues
    const cleanTitle = cleanNewsTitle(title);

    // Header: Using standard Markdown Header
    const headerContent = `### [${cleanTitle}](${link})\n-# ${author} • ${date}`;

    const textDisplayHelper = new TextDisplayBuilder().setContent(
      headerContent,
    );

    if (news.user.avatar) {
      const headerSection = new SectionBuilder()
        .addTextDisplayComponents(textDisplayHelper)
        .setThumbnailAccessory(
          new ThumbnailBuilder({ media: { url: news.user.avatar } }),
        );
      container.addSectionComponents(headerSection);
    } else {
      container.addTextDisplayComponents(textDisplayHelper);
    }

    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(2),
    );

    // --- Body Content ---
    if (news.item.caption) {
      let bodyBuffer = "";

      for (const block of news.item.caption) {
        let blockContent = "";

        if (block.kind === "text" && block.text) {
          blockContent = block.text.text;
          if (!blockContent) continue;

          // Heuristic: Bold important categories/headers
          if (
            /^([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])?\s*[\u4e00-\u9fa5\w]{2,12}(：|:)/.test(
              blockContent,
            ) ||
            /^【[\u4e00-\u9fa5\w]{2,12}】/.test(blockContent)
          ) {
            blockContent = `**${blockContent}**`;
          }
        } else if (block.kind === "link" && block.link) {
          const linkText = block.link.text;
          const linkUrl = block.link.link;
          blockContent =
            linkText === linkUrl ? linkUrl : `[${linkText}](${linkUrl})`;
        }

        if (blockContent) {
          // If bodyBuffer has content and doesn't end with a newline,
          // and the new block looks like a new line/paragraph, add a newline.
          if (
            bodyBuffer &&
            !bodyBuffer.endsWith("\n") &&
            !blockContent.startsWith("\n")
          ) {
            // Newline if:
            // 1. New block starts with emoji or 【
            // 2. Previous block was fairly long or ended with punctuation
            if (
              /^([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]|【)/.test(
                blockContent,
              ) ||
              bodyBuffer.length > 30 ||
              /[。！？；：…\)\"」』\>]$/.test(bodyBuffer)
            ) {
              bodyBuffer += "\n";
            }
          }
          bodyBuffer += blockContent;
        }
      }

      if (bodyBuffer.trim()) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(bodyBuffer.trim()),
        );
      }
    }

    // --- Images ---
    const images: any[] = [];
    if (news.item.cover) images.push({ media: { url: news.item.cover.url } });
    if (news.item.album) {
      news.item.album.forEach((img) => {
        images.push({ media: { url: img.image.url } });
      });
    }

    if (images.length > 0) {
      const mediaGallery = new MediaGalleryBuilder();
      images.slice(0, 4).forEach((img) => {
        mediaGallery.addItems(
          new MediaGalleryItemBuilder({ media: img.media }),
        );
      });
      container.addMediaGalleryComponents(mediaGallery);
    }

    return {
      content: "",
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    };
  }
}
