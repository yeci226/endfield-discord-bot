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

import { formatAcceptLanguage, formatSkLanguage } from "../utils/skportApi";

const SKPORT_API_URL =
  "https://zonai.skport.com/web/v1/home/index?pageSize=3&sortType=2&gameId=3&cateId=1006";
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

      const response = await axios.get(SKPORT_API_URL, {
        headers: {
          authority: "zonai.skport.com",
          accept: "*/*",
          "accept-language": formatAcceptLanguage("zh-TW"),
          origin: "https://www.skport.com",
          platform: "3",
          referer: "https://www.skport.com/",
          "sk-language": formatSkLanguage("zh-TW"),
          vname: "1.0.0",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        },
      });

      if (response.data.code !== 0 || !response.data.data.list) {
        this.logger.error(
          `Failed to fetch Skport news: ${response.data.message}`,
        );
        return;
      }

      const newsList: SkportNewsItem[] = response.data.data.list;

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
    // Get Subscriptions
    const subscriptions =
      ((await this.client.db.get("news_subscriptions")) as Array<{
        guildId: string;
        channelId: string;
        boundAt: number;
      }>) || [];

    const payload = this.buildPayload(news, title);

    for (const sub of subscriptions) {
      // Check Dispatch Record
      const dispatchKey = `news_dispatch.${news.item.id}.${sub.channelId}`;
      const dispatchRecord = await this.client.db.get(dispatchKey);

      try {
        const channel = (await this.client.channels.fetch(sub.channelId)) as
          | TextChannel
          | NewsChannel;
        if (!channel) continue;

        const channelName = (channel as any).name || "DM";

        if (dispatchRecord && !force) {
          // Already sent to this channel
          if (isUpdate && dispatchRecord.hash !== currentHash) {
            // Needs Edit
            try {
              const message = await channel.messages.fetch(
                dispatchRecord.messageId,
              );
              if (message) {
                await message.edit(payload);
                this.logger.success(`Updated message in ${channelName}`);
                await this.client.db.set(dispatchKey, {
                  ...dispatchRecord,
                  hash: currentHash,
                });
              }
            } catch (e) {
              this.logger.warn(
                `Could not edit message in ${channelName}, maybe deleted?`,
              );
            }
          }
        } else {
          // New Dispatch (or Force Dispatch)
          // Skip if news is older than binding time (to avoid spamming old news on new bind)
          // Unless force is true.
          const newsTime = parseInt(news.item.timestamp) * 1000;
          if (!force && sub.boundAt && newsTime < sub.boundAt) continue;

          const message = await channel.send(payload);
          this.logger.success(
            `${force ? "Force sent" : "Sent"} message to ${channelName}`,
          );
          await this.client.db.set(dispatchKey, {
            newsId: news.item.id,
            guildId: sub.guildId,
            channelId: sub.channelId,
            messageId: message.id,
            hash: currentHash,
          });
        }
      } catch (error) {
        this.logger.error(`Failed to dispatch to ${sub.channelId}: ${error}`);
      }
    }
  }

  private buildPayload(news: SkportNewsItem, title: string): any {
    const container = new ContainerBuilder();

    const author = news.user.nickname || "Official";
    const date = `<t:${Math.floor(parseInt(news.item.timestamp))}:f>`;
    const link = `https://www.skport.com/article?id=${news.item.id}`;
    const headerContent = `### [${title}](${link})\n-# ${author} • ${date}`;

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
      let textBuffer = "";

      const flushText = () => {
        if (textBuffer.trim()) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(textBuffer.trim()),
          );
          textBuffer = "";
        }
      };

      for (const block of news.item.caption) {
        if (block.kind === "text" && block.text) {
          textBuffer += block.text.text;
        } else if (block.kind === "link" && block.link) {
          const linkText = block.link.text;
          const linkUrl = block.link.link;

          if (linkText === linkUrl) {
            textBuffer += `${linkUrl}`;
          } else {
            textBuffer += `[${linkText}](${linkUrl})`;
          }
        }
      }
      flushText();
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
