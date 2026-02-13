import { ExtendedClient } from "../structures/Client";
import fs from "fs";
import path from "path";
import axios from "axios";
import {
  getItemCatalog,
  getItemInfo,
  refreshSkToken,
} from "../utils/skportApi";
import { Logger } from "../utils/Logger";
import colors from "colors";

export class CharacterWikiService {
  private client: ExtendedClient;
  private logger: Logger;
  private interval: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;
  private downloadDir: string;

  constructor(client: ExtendedClient) {
    this.client = client;
    this.logger = new Logger("CharacterWiki");
    // Standardize path to use / even on Windows for URL/asset mapping consistency if needed,
    // but fs.join handles OS differences.
    this.downloadDir = path.join(__dirname, "../assets/illustrators");

    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  public async start() {
    this.logger.info("Character Wiki Service Started");

    // 檢查上次執行時間，避免一天內多次啟動導致重複掃描
    const lastSync = await this.client.db.get("wiki_last_sync_timestamp");
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    // 檢查資料夾是否為空，如果為空則強制啟動同步
    const isDirEmpty =
      !fs.existsSync(this.downloadDir) ||
      fs.readdirSync(this.downloadDir).length === 0;

    if (
      !isDirEmpty &&
      lastSync &&
      now - (lastSync as number) < twentyFourHours
    ) {
      const remainingHours = Math.round(
        (twentyFourHours - (now - (lastSync as number))) / (60 * 60 * 1000),
      );
      this.logger.info(
        `Character Wiki sync skipped. Last sync was less than 24h ago. Next run in ~${remainingHours}h.`,
      );
    } else {
      setTimeout(() => this.checkAndDownload(), 10000);
    }

    // 啟動修復檢查（不論是否全掃描都執行）
    this.checkAndRepair();

    // 每 24 小時排程一次
    this.interval = setInterval(() => this.checkAndDownload(), twentyFourHours);
  }

  /**
   * 智慧修理：檢查已追蹤的角色是否有檔案遺失
   */
  private async asyncSeedTrackedIds() {
    // 從檔案名稱中提取所有已存在的角色 ID
    const files = fs.readdirSync(this.downloadDir);
    const ids = new Set<string>();
    files.forEach((f) => {
      const match = f.match(/^(\d+)_/);
      if (match) ids.add(match[1]);
    });

    if (ids.size > 0) {
      const trackedIds = Array.from(ids);
      await this.client.db.set("wiki_tracked_item_ids", trackedIds);
      this.logger.info(`Seeded ${trackedIds.length} character IDs from disk.`);
      return trackedIds;
    }
    return [];
  }

  private async checkAndRepair() {
    try {
      let trackedIds: (string | number)[] =
        ((await this.client.db.get("wiki_tracked_item_ids")) as (
          | string
          | number
        )[]) || [];

      // 如果資料庫是空的，嘗試從磁碟補回（冷啟動或資料庫清空時有用）
      if (trackedIds.length === 0) {
        trackedIds = await this.asyncSeedTrackedIds();
      }

      if (trackedIds.length === 0) return;

      this.logger.info(
        `Checking health for ${trackedIds.length} tracked characters...`,
      );
      const accountData = await this.getValidAccount();
      if (!accountData) return;

      for (const itemId of trackedIds) {
        // 簡單檢查：如果 _1, _2, _3 任一遺失且資料庫有紀錄，就觸發單點更新
        const dbKey = `wiki_downloaded_images:${itemId}`;
        const downloadedIds: string[] =
          ((await this.client.db.get(dbKey)) as string[]) || [];

        if (downloadedIds.length === 0) continue;

        let needRepair = false;
        for (let i = 2; i <= downloadedIds.length; i++) {
          if (
            !fs.existsSync(path.join(this.downloadDir, `${itemId}_${i}.png`))
          ) {
            needRepair = true;
            break;
          }
        }

        if (needRepair) {
          this.logger.info(`Repairing missing files for item ${itemId}...`);

          // 自動修正編號偏移或頭像錯誤：
          // 1. 如果 _1.png 遺失
          // 2. 如果 _1.png 太小 (小於 150KB，通常是正方形頭像)
          const file1Path = path.join(this.downloadDir, `${itemId}_1.png`);
          const file1Exists = fs.existsSync(file1Path);
          let isTooSmall = false;
          if (file1Exists) {
            const stats = fs.statSync(file1Path);
            if (stats.size < 153600) {
              // 150KB
              isTooSmall = true;
            }
          }

          if ((!file1Exists || isTooSmall) && downloadedIds.length > 0) {
            this.logger.warn(
              `Item ${itemId} ${!file1Exists ? "missing index 1" : "has small index 1 (likely icon)"}. Resetting history to fix art.`,
            );
            await this.deleteDownloadedHistory(itemId);
          }

          await this.processItem(itemId, accountData);
        }
      }
    } catch (e: any) {
      this.logger.error(`Repair check failed: ${e.message}`);
    }
  }

  public stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  public async checkAndDownload(force: boolean = false) {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      fs.appendFileSync(
        "wiki_debug.log",
        `[${new Date().toISOString()}] Starting checkAndDownload\n`,
      );
      const accountData = await this.getValidAccount();
      if (!accountData) {
        console.warn("[CharacterWiki] No valid user account found.");
        return;
      }

      console.log(`[CharacterWiki] Using account ${accountData.id}`);

      let catalogRes = await getItemCatalog(
        1,
        accountData.cred,
        "zh_Hant",
        accountData.salt,
      );
      fs.appendFileSync(
        "wiki_debug.log",
        `[${new Date().toISOString()}] Catalog Code: ${catalogRes?.code}\n`,
      );

      // Handle Code 10000 (Auth/Sign failed, likely stale token)
      if (catalogRes?.code === 10000) {
        fs.appendFileSync(
          "wiki_debug.log",
          `[${new Date().toISOString()}] Auth failed (10000), attempting token refresh...\n`,
        );
        const newToken = await refreshSkToken(accountData.cred);
        if (newToken) {
          fs.appendFileSync(
            "wiki_debug.log",
            `[${new Date().toISOString()}] Token refreshed. Retrying catalog fetch.\n`,
          );
          accountData.salt = newToken; // Update salt for this session
          catalogRes = await getItemCatalog(
            1,
            accountData.cred,
            "zh_Hant",
            accountData.salt,
          );
          fs.appendFileSync(
            "wiki_debug.log",
            `[${new Date().toISOString()}] Retry Catalog Code: ${catalogRes?.code}\n`,
          );
        } else {
          fs.appendFileSync(
            "wiki_debug.log",
            `[${new Date().toISOString()}] Token refresh failed.\n`,
          );
        }
      }

      if (!catalogRes || catalogRes.code !== 0 || !catalogRes.data?.catalog) {
        fs.appendFileSync(
          "wiki_debug.log",
          `[${new Date().toISOString()}] Failed fetch: ${catalogRes?.message}\n`,
        );
        return;
      }

      const catalog = catalogRes.data.catalog || [];
      fs.appendFileSync(
        "wiki_debug.log",
        `[${new Date().toISOString()}] Groups found: ${catalog.length}\n`,
      );

      let totalProcessed = 0;

      // Helper to process a list of items
      const processItemList = async (items: any[], sourceName: string) => {
        fs.appendFileSync(
          "wiki_debug.log",
          `[${new Date().toISOString()}] Processing list from ${sourceName}: ${items.length} items\n`,
        );
        for (const item of items) {
          if (item && item.itemId) {
            await this.processItem(item.itemId, accountData);
            totalProcessed++;
            await new Promise((resolve) => setTimeout(resolve, 500)); // Delay to avoid rate limits
          }
        }
      };

      for (let i = 0; i < catalog.length; i++) {
        const entry = catalog[i];
        const groupName = entry.name || "Unknown";

        // 檢查頂層群組是否已經是幹員類別
        const isStrictOperator =
          groupName.includes("幹員") ||
          groupName.includes("角色") ||
          groupName.includes("人员") ||
          groupName.includes("Operator") ||
          groupName.includes("Characters");

        // 如果只有一個群組或者是百科，我們也要進去看看
        const shouldEnter =
          isStrictOperator ||
          catalog.length === 1 ||
          groupName.includes("百科");

        if (!shouldEnter) {
          this.logger.debug(`Skipping non-operator group: ${groupName}`);
          continue;
        }

        this.logger.info(`Processing operator group: ${groupName}...`);

        // 1. Check direct items (僅在群組本身就是幹員類時處理)
        if (
          isStrictOperator &&
          entry.items &&
          Array.isArray(entry.items) &&
          entry.items.length > 0
        ) {
          await processItemList(
            entry.items,
            `Group ${i} (${groupName}) direct items`,
          );
        }

        // 2. Check typeSub items
        if (entry.typeSub && Array.isArray(entry.typeSub)) {
          for (let j = 0; j < entry.typeSub.length; j++) {
            const sub = entry.typeSub[j];
            const subName = sub.name || "Unknown";

            // 如果父目錄不是嚴格的幹員類別，則子目錄必須符合關鍵字
            const isOperatorSub =
              isStrictOperator ||
              subName.includes("幹員") ||
              subName.includes("角色") ||
              subName.includes("人员") ||
              subName.includes("Operator") ||
              subName.includes("Characters");

            if (!isOperatorSub) {
              continue;
            }

            if (sub.items && Array.isArray(sub.items) && sub.items.length > 0) {
              await processItemList(
                sub.items,
                `Group ${i} (${groupName}) -> Sub ${j} (${subName})`,
              );
            }
          }
        }
      }

      fs.appendFileSync(
        "wiki_debug.log",
        `[${new Date().toISOString()}] Finished. Processed ${totalProcessed} items.\n`,
      );

      console.log(
        `[CharacterWiki] Finished. Processed ${totalProcessed} items.`,
      );

      // 只有在真的有處理到東西時才更新時間戳記，避免因為資料不完整導致今天都不再執行
      if (totalProcessed > 0 && !force) {
        await this.client.db.set("wiki_last_sync_timestamp", Date.now());
        this.logger.success("Daily wiki sync completed and timestamp updated.");
      } else if (totalProcessed > 0) {
        this.logger.success(
          `Manual sync finished. Processed ${totalProcessed} items.`,
        );
      } else {
        this.logger.warn(
          "Processed 0 items. Possible data restriction or empty catalog. Will retry on next start.",
        );
      }
    } catch (error: any) {
      this.logger.error(`Error in character info check: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  public async processItem(itemId: string | number, accountData: any) {
    try {
      // 紀錄已追蹤的 ID
      const trackedIds: (string | number)[] =
        ((await this.client.db.get("wiki_tracked_item_ids")) as (
          | string
          | number
        )[]) || [];
      if (!trackedIds.includes(itemId)) {
        trackedIds.push(itemId);
        await this.client.db.set("wiki_tracked_item_ids", trackedIds);
      }

      // 智慧跳過：如果所有可能存在的圖片都已在磁碟上，則跳過 API 請求減少追蹤與日誌
      const dbKey = `wiki_downloaded_images:${itemId}`;
      const downloadedIds: string[] =
        ((await this.client.db.get(dbKey)) as string[]) || [];

      if (downloadedIds.length > 0) {
        let allExist = true;
        for (let i = 1; i <= downloadedIds.length; i++) {
          if (
            !fs.existsSync(path.join(this.downloadDir, `${itemId}_${i}.png`))
          ) {
            allExist = false;
            break;
          }
        }
        if (allExist) {
          // 如果全部存在，除了極低機率的增益更新外，不需要再請求 getItemInfo
          // 我們每 24 小時才強制執行的主邏輯會處理新增的角色，這裡主要是 checkAndRepair 觸發或主迴圈遍歷
          return;
        }
      }

      const infoRes = await getItemInfo(
        itemId,
        accountData.cred,
        "zh_Hant",
        accountData.salt,
      );
      if (!infoRes || infoRes.code !== 0 || !infoRes.data?.item) {
        this.logger.error(`Failed to fetch info for item ${itemId}`);
        return;
      }

      fs.appendFileSync(
        "wiki_debug.log",
        `[${new Date().toISOString()}] InfoRes keys for ${itemId}: ${Object.keys(infoRes.data).join(", ")}\n`,
      );
      const itemInfo = infoRes.data.item;
      const itemName = itemInfo.name;

      // Search for illustrator images
      const imageUrls: { url: string; id?: string }[] = [];
      const addImageUrl = (
        url: string,
        id?: string,
        meta?: { width?: number; height?: number; size?: number },
      ) => {
        if (!url || !url.startsWith("http")) return;
        const lowUrl = url.toLowerCase();
        // 排除 GIF 與常見的小圖/頭像路徑
        if (lowUrl.endsWith(".gif")) return;
        if (
          lowUrl.includes("/icon/") ||
          lowUrl.includes("/avatar/") ||
          lowUrl.includes("/square/") ||
          lowUrl.includes("/common/") ||
          lowUrl.includes("/head/")
        )
          return;

        // 偵測正方形圖片 (通常為頭像)
        if (meta && meta.width && meta.height) {
          if (Math.abs(meta.width - meta.height) < 10) return;
        }

        // 偵測過小的檔案 (通常為頭像)
        if (meta && meta.size && meta.size < 51200) return;

        if (!imageUrls.find((item) => item.url === url)) {
          imageUrls.push({ url, id });
        }
      };

      // 1. Look in extraInfo (Character illustration is usually here, prioritize this)
      if (itemInfo.extraInfo) {
        if (itemInfo.extraInfo.illustration) {
          addImageUrl(itemInfo.extraInfo.illustration);
        }
        if (itemInfo.extraInfo.illustrator_img) {
          addImageUrl(itemInfo.extraInfo.illustrator_img);
        }
      }

      // 注意：暫時移除 brief.cover (通常是正方形頭像) 除非以後發現某些角色只有這個
      // if (itemInfo.brief && itemInfo.brief.cover) { ... }

      // 2. Look in base details (fallback)
      if (itemInfo.illustrationUrl) {
        addImageUrl(itemInfo.illustrationUrl);
      }

      // 3. Look in modules for "繪師" or "立繪" or "Illustration"
      if (itemInfo.modules) {
        for (const mod of itemInfo.modules) {
          const modName = (mod.name || mod.title || "").trim();
          if (
            modName.includes("繪師") ||
            modName.includes("立繪") ||
            modName.includes("Illustrator")
          ) {
            if (mod.content && mod.content.url) {
              addImageUrl(mod.content.url);
            } else if (mod.images && mod.images.length > 0) {
              for (const img of mod.images) {
                addImageUrl(img.url, img.id, {
                  width: img.width,
                  height: img.height,
                  size: img.size,
                });
              }
            }
          }
        }
      }

      // 4. Fallback: search extension data or entire module content
      if (itemInfo.ext) {
        try {
          const ext =
            typeof itemInfo.ext === "string"
              ? JSON.parse(itemInfo.ext)
              : itemInfo.ext;
          if (ext.illustrator_img) {
            addImageUrl(ext.illustrator_img);
          }
          if (ext.illustration) {
            addImageUrl(ext.illustration);
          }
        } catch (e) {}
      }

      // 5. Check widgetCommonMap (User provided source)
      if (itemInfo.widgetCommonMap) {
        const widgets = Object.values(itemInfo.widgetCommonMap) as any[];
        for (const widget of widgets) {
          if (widget.kind === "image" && widget.image) {
            const desc = widget.image.description || "";
            if (desc.includes("繪師") || desc.includes("Illustrator")) {
              addImageUrl(widget.image.url, widget.image.id);
            }
          }
        }
      }

      // 6. Check document documentMap -> blockMap (Primary source for many characters)
      if (itemInfo.document && itemInfo.document.documentMap) {
        const docMaps = Object.values(itemInfo.document.documentMap) as any[];
        for (const doc of docMaps) {
          if (doc.blockMap) {
            const blocks = Object.values(doc.blockMap) as any[];
            for (const block of blocks) {
              if (block.kind === "image" && block.image) {
                const desc = block.image.description || "";
                if (
                  desc.includes("繪師") ||
                  desc.includes("立繪") ||
                  desc.includes("Illustrator")
                ) {
                  addImageUrl(block.image.url, block.image.id, {
                    width: block.image.width,
                    height: block.image.height,
                    size: block.image.size,
                  });
                }
              }
            }
          }
        }
      }

      if (imageUrls.length > 0) {
        this.logger.info(
          `Found ${imageUrls.length} illustrator image(s) for ${itemName} (${itemId}).`,
        );

        // Track downloaded images to avoid duplicates and maintain stable indexing
        const dbKey = `wiki_downloaded_images:${itemId}`;
        const downloadedIds: string[] =
          ((await this.client.db.get(dbKey)) as string[]) || [];
        let updated = false;

        for (let i = 0; i < imageUrls.length; i++) {
          const { url, id } = imageUrls[i];
          const imageIdentifier = id || url;

          // Find if this image was already assigned an index
          let existingIndex = downloadedIds.indexOf(imageIdentifier);
          let fileName = "";

          if (existingIndex !== -1) {
            fileName = `${itemId}_${existingIndex + 1}.png`;
            const filePath = path.join(this.downloadDir, fileName);

            if (fs.existsSync(filePath)) {
              this.logger.debug(
                `Image ${imageIdentifier} already exists as ${fileName}, skipping.`,
              );
              continue;
            }
            this.logger.info(
              `File ${fileName} missing but ID tracked, re-downloading...`,
            );
          } else {
            // New image, assign next index
            downloadedIds.push(imageIdentifier);
            existingIndex = downloadedIds.length - 1;
            fileName = `${itemId}_${existingIndex + 1}.png`;
            updated = true;
          }

          const filePath = path.join(this.downloadDir, fileName);
          this.logger.info(
            `Downloading image ${existingIndex + 1}: ${fileName}...`,
          );
          await this.downloadImage(url, filePath);
        }

        if (updated) {
          await this.client.db.set(dbKey, downloadedIds);
        }
      } else {
        this.logger.warn(
          `No illustrator image found for ${itemName} (${itemId}).`,
        );
        // Log keys and content to see structure for debugging
        this.logger.info(
          `Item structure keys: ${Object.keys(itemInfo).join(", ")}`,
        );
        if (itemInfo.extraInfo) {
          this.logger.info(
            `extraInfo keys: ${Object.keys(itemInfo.extraInfo).join(", ")}`,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(`Error processing item ${itemId}: ${error.message}`);
    }
  }

  /**
   * 清除特定角色的下載歷史紀錄並刪除實體檔案
   */
  public async deleteDownloadedHistory(itemId: string | number) {
    const dbKey = `wiki_downloaded_images:${itemId}`;
    await this.client.db.delete(dbKey);

    // 刪除實體檔案
    try {
      const files = await fs.promises.readdir(this.downloadDir);
      const targets = files.filter((f) => f.startsWith(`${itemId}_`));
      for (const file of targets) {
        await fs.promises.unlink(path.join(this.downloadDir, file));
      }
      this.logger.info(
        `Cleared download history and deleted ${targets.length} files for item ${itemId}`,
      );
    } catch (e: any) {
      this.logger.error(
        `Failed to delete files for item ${itemId}: ${e.message}`,
      );
    }
  }

  private async downloadImage(url: string, filePath: string) {
    try {
      const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
      });

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to download image from ${url}: ${error.message}`,
      );
    }
  }

  private async getAllAccounts() {
    const dailyData =
      ((await this.client.db.get("autoDaily")) as Record<string, any>) || {};
    if (!dailyData) return [];

    const accountsList: any[] = [];
    const userIds = Object.keys(dailyData);

    // Crypto
    let decryptAccount: any;
    try {
      const cryptoUtils = require("../utils/cryptoUtils");
      decryptAccount = cryptoUtils.decryptAccount;
    } catch (e) {
      this.logger.error("Failed to load cryptoUtils");
      return [];
    }

    for (const userId of userIds) {
      const accounts =
        ((await this.client.db.get(`${userId}.accounts`)) as any[]) || [];
      if (!accounts || !Array.isArray(accounts)) continue;

      for (const encAcc of accounts) {
        try {
          const decAcc = decryptAccount(encAcc);
          if (decAcc && decAcc.cred && decAcc.salt) {
            // attach id and userId for reference
            // Identify account ID correctly (usually in decAcc.info.id)
            const accountId =
              encAcc.id || decAcc.id || decAcc.info?.id || "Unknown";

            decAcc.id = accountId;
            decAcc.userId = userId;
            accountsList.push(decAcc);
          }
        } catch (e) {
          // ignore decryption errors
        }
      }
    }
    return accountsList;
  }

  public async getValidAccount() {
    // Return best account or first one
    const accounts = await this.getAllAccounts();
    if (accounts.length === 0) return null;

    // Priority/Cache First
    const priorityId = "8911159310760";
    const lastId = (await this.client.db.get(
      "wiki_last_robust_account_id",
    )) as string;

    const priorityIdx = accounts.findIndex(
      (a) =>
        a.id.startsWith(priorityId) ||
        a.userId === priorityId ||
        a.id === priorityId,
    );
    if (priorityIdx !== -1) {
      const [priorityAcc] = accounts.splice(priorityIdx, 1);
      accounts.unshift(priorityAcc);
      this.logger.debug(`Prioritizing requested account: ${priorityId}`);
    } else if (lastId) {
      const cachedIdx = accounts.findIndex((a) => a.id === lastId);
      if (cachedIdx !== -1) {
        // Move cached account to front to try it first
        const [cachedAcc] = accounts.splice(cachedIdx, 1);
        accounts.unshift(cachedAcc);
        this.logger.debug(`Trying cached robust account first: ${lastId}`);
      }
    }

    console.log(
      `Found ${accounts.length} potential accounts. Testing for robustness...`,
    );

    // Filter for account that can see FULL item info
    for (const acc of accounts) {
      try {
        // Check item 21 (Perica) for extraInfo
        // Note: Using skportApi.getItemInfo (no gameId: 3)
        let res = await getItemInfo(21, acc.cred, "zh_Hant", acc.salt);

        // Refresh if stale (Code 10000) OR if data is missing (Code 0 but public/restricted view)
        const hasExtraInitial = !!res?.data?.item?.extraInfo;
        const hasWidgetInitial = !!res?.data?.item?.widgetCommonMap;

        if (
          (res && res.code === 10000) ||
          (res && res.code === 0 && !hasExtraInitial && !hasWidgetInitial)
        ) {
          console.log(
            `Token likely stale (Code ${res.code}, Missing Data), refreshing account ${acc.id}...`,
          );
          const newToken = await refreshSkToken(acc.cred);
          if (newToken) {
            acc.salt = newToken;
            res = await getItemInfo(21, acc.cred, "zh_Hant", acc.salt);
          }
        }

        const hasExtra = !!res?.data?.item?.extraInfo;
        const hasWidget = !!res?.data?.item?.widgetCommonMap;

        if (res && res.code === 0 && (hasExtra || hasWidget)) {
          if (acc.id !== lastId) {
            await this.client.db.set("wiki_last_robust_account_id", acc.id);
            this.logger.info(`Updated robust account cache: ${acc.id}`);
          }
          console.log(`Found robust account: ${acc.userId} / ${acc.id}`);
          return {
            id: acc.id,
            cred: acc.cred,
            salt: acc.salt,
          };
        } else {
          console.warn(
            `Account ${acc.id} rejected. Code: ${res?.code}, HasExtra: ${hasExtra}, HasWidget: ${hasWidget}`,
          );
        }
      } catch (e) {
        // ignore
      }
    }

    console.warn("No robust account found. Using first available.");
    const first = accounts[0];
    return {
      id: first.id,
      cred: first.cred,
      salt: first.salt,
    };
  }
}
