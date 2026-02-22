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

export class SkportNewsService {
  private client: ExtendedClient;
  private interval: NodeJS.Timeout | null = null;
  private isReady: boolean = false;
  private logger: Logger;

  constructor(client: ExtendedClient) {
    this.client = client;
    this.logger = new Logger("SkportNews");
  }

  public start() {
    this.logger.info("Skport News Service Started");
    this.manualCheckNews();
    this.interval = setInterval(() => this.manualCheckNews(), POLL_INTERVAL);
    this.isReady = true;
  }

  public stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  public async manualCheckNews(force: boolean = false) {
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

      let newsList: SkportNewsItem[] = [];
      if (response && Array.isArray(response.list)) {
        newsList = response.list;
      } else if (
        response &&
        response.data &&
        Array.isArray(response.data.list)
      ) {
        newsList = response.data.list;
      }

      if (newsList.length === 0) {
        this.logger.error(
          `Failed to fetch Skport news: ${response?.message || "Invalid response structure or no news found"}`,
        );
        return;
      }

      if (force) {
        // Only process the single absolute latest item if forcing
        if (newsList.length > 0) {
          await this.processNews(newsList[0], true);
        }
        return;
      }

      // Process top 3 items, oldest first to maintain order if multiple new
      const top3 = newsList.slice(0, 3).reverse();

      for (const news of top3) {
        await this.processNews(news);
      }
    } catch (error: any) {
      this.logger.error(`Error checking Skport news: ${error.message}`);
    }
  }

  private async processNews(news: SkportNewsItem, force: boolean = false) {
    const newsId = news.item.id;
    const captionBlocks = news.item.caption || [];

    // 1. Determine Title (Fallback if empty)
    let title = news.item.title;
    if (!title || title.trim() === "") {
      // Find first text
      const firstText = captionBlocks.find(
        (b) => b.kind === "text" && b.text && b.text.text.trim().length > 0,
      );
      title = firstText
        ? firstText.text!.text.substring(0, 50) +
          (firstText.text!.text.length > 50 ? "..." : "")
        : "Endfield News";
    }

    // 2. Generate Content Hash (to detect updates)
    const contentString =
      JSON.stringify(news.item.caption) +
      (news.item.title || "") +
      (news.item.cover?.url || "");
    const currentHash = crypto
      .createHash("md5")
      .update(contentString)
      .digest("hex");

    // 3. Check DB
    const historyKey = `news_history.${newsId}`;
    const storedNews = await this.client.db.get(historyKey);

    const isNew = !storedNews;
    const isUpdated = storedNews && storedNews.hash !== currentHash;

    if (!isNew && !isUpdated && !force) return; // No change

    if (force) {
      this.logger.info(`Force Resending News: ${title} (${newsId})`);
    } else if (isUpdated) {
      this.logger.info(`News Updated: ${title} (${newsId})`);
    } else {
      this.logger.info(`New News Found: ${title} (${newsId})`);
    }

    // 4. Update History
    await this.client.db.set(historyKey, {
      id: newsId,
      title,
      hash: currentHash,
      timestamp: Date.now(),
    });

    // 5. Dispatch
    await this.dispatch(news, title, currentHash, isUpdated, force);
  }

  private async dispatch(
    news: SkportNewsItem,
    title: string,
    currentHash: string,
    isUpdate: boolean,
    force: boolean = false,
  ) {
    const subscriptions =
      ((await this.client.db.get("news_subscriptions")) as Array<{
        guildId: string;
        channelId: string;
        boundAt: number;
      }>) || [];

    const payload = this.buildPayload(news, title);

    // Prepare subscription data for broadcast
    const subData = await Promise.all(
      subscriptions.map(async (sub) => {
        const dispatchKey = `news_dispatch.${news.item.id}.${sub.channelId}`;
        const dispatchRecord = await this.client.db.get(dispatchKey);
        const newsTime = parseInt(news.item.timestamp) * 1000;
        const skip = !force && sub.boundAt && newsTime < sub.boundAt;

        return {
          ...sub,
          dispatchRecord,
          skip,
        };
      }),
    );

    const eligibleSubs = subData.filter((s) => !s.skip);

    // Broadcast ONCE to all clusters
    const broadcastResults = await this.client.cluster.broadcastEval(
      async (c: any, context: any) => {
        const results: Array<{
          channelId: string;
          messageId: string;
          isNew: boolean;
        }> = [];

        for (const sub of context.eligibleSubs) {
          try {
            // Check if this cluster owns the channel
            const channel = c.channels.cache.get(sub.channelId);
            if (!channel) continue;

            if (sub.dispatchRecord && !context.force) {
              if (
                context.isUpdate &&
                sub.dispatchRecord.hash !== context.currentHash
              ) {
                // Update existing
                const message = await channel.messages.fetch(
                  sub.dispatchRecord.messageId,
                );
                if (message) {
                  await message.edit(context.payload);
                  results.push({
                    channelId: sub.channelId,
                    messageId: sub.dispatchRecord.messageId,
                    isNew: false,
                  });
                }
              }
            } else {
              // New send
              const msg = await channel.send(context.payload);
              results.push({
                channelId: sub.channelId,
                messageId: msg.id,
                isNew: true,
              });
            }
          } catch (e) {}
        }
        return results;
      },
      {
        context: {
          eligibleSubs,
          payload,
          isUpdate,
          currentHash,
          force,
        },
      },
    );

    // Flatten results and update DB
    const allResults = broadcastResults.flat();
    for (const res of allResults) {
      const dispatchKey = `news_dispatch.${news.item.id}.${res.channelId}`;
      const existing = (await this.client.db.get(dispatchKey)) || {};
      await this.client.db.set(dispatchKey, {
        newsId: news.item.id,
        channelId: res.channelId,
        messageId: res.messageId,
        hash: currentHash,
        ...existing, // Keep guildId etc if exists
      });
      this.logger.success(
        `${res.isNew ? "Sent" : "Updated"} message to Channel(${res.channelId})`,
      );
    }
  }

  private buildPayload(news: SkportNewsItem, title: string): any {
    const container = new ContainerBuilder();

    const author = news.user.nickname || "Official";
    const date = `<t:${Math.floor(parseInt(news.item.timestamp))}:f>`;
    const link = `https://www.skport.com/article?id=${news.item.id}`;

    // Clean title: Remove leading/trailing brackets to avoid Markdown link issues
    const cleanTitle = title.replace(/^\[|\]$/g, "").trim();

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
