# 終末地 Discord bot：優化與功能擴充 設計

日期：2026-11-19
Repo：`bots/endfield-discord-bot`（`main` @ 45075bf，與 GitHub 同步）

## 1. 目的

使用者要把這個 bot 整理好，主要動機是**效能與效率**，同時補上值得加的功能。
規劃由主 session 負責，實作分派給多個 Sonnet 平行進行，主 session 驗收並合併。

## 2. 現況（2026-11-19 實測）

正式環境在 Mac（`ssh yeci@100.115.71.58`），pm2 app `endfield`，資料夾
`~/Desktop/bots/endfield`，**不是 git repo**，以 `yarn start`（tsc build 後跑
`dist/cluster.js`）啟動，另有 `cloudflared-endfield` 把網頁伺服器（port 3838）對外。

- 5 個 cluster 程序，各約 140–260MB。
- `json.sqlite` 884MB、136,594 列，單一 key/value 表 `json(ID, json)`。
  - 抽卡紀錄 `GACHA_LOG_*`：約 3,400 列共 ~685MB，單筆最大 2.6MB。每次看統計都要整筆 parse，每次匯入整筆重寫。
  - `GACHA_LEADERBOARD_ENTRIES`：**單一一筆 6.9MB**，每次有人看統計卡就整筆讀出、改、寫回。
  - `news_dispatch.*`：107,185 列，只增不減。
  - `autoDaily.*`：5,075 位自動簽到使用者。
- `telemetry.sqlite` 171MB。
- Mac 上的 `src` 已與 45075bf 比對（2026-11-19）：只差 `gacha.ts` 與 `gachaLogUtils.ts` 兩個檔，差異就是 11/17 那個「連結帳號 401」修正尚未部署；Mac 上沒有 repo 沒有的改動（只有幾個 `.bak` 檔和一個空的 `src/scripts`）。**repo 的 `main` 是安全的起點。**
- Mac 的 `.env` 已設定 `ENCRYPTION_KEY`（只確認存在，未讀值）。
- 語言檔是兩個單一檔案：`src/assets/languages/en.ts`、`tw.ts`。
- 指令由 `src/handlers/commandHandler.ts` 遞迴載入 `src/commands` 下所有 `.ts`，所以**非指令檔不能放在 `src/commands` 底下**。`commands-manifest.json` 是 3 月產生的舊檔，沒有程式讀它，所有線都不要動。

四份程式碼盤點的完整發現見本文件第 6 節各工作項（每項都附了來源檔案位置）。

## 3. 目標／不做的事

**目標**
1. 常用操作變快：看抽卡統計、翻頁、匯入紀錄、排行榜。
2. 任何使用者現在就能利用的漏洞全部關掉。
3. 「看起來有在運作但其實沒有」的功能修好（自動簽到重試、私訊新聞、token 過期通知、binding roles、跨 cluster 驗證碼登入）。
4. 抽卡統計數字正確。
5. 程式碼拆到多個 Sonnet 可以同時改而不衝突，測試有指令可以跑。
6. 第一批新功能上線。

**這次不做**
- 不把抽卡紀錄從 JSON blob 改成「一抽一列」的正規表。原因：要在 884MB 的正式資料庫上做不可逆遷移，風險與工作量都大；本次用「統計結果快取」拿到大部分效益。之後可另開一案。
- 不換資料庫、不換框架、不重寫 canvas 繪圖的視覺。
- 不加任何金幣／任務／經驗值類的遊戲化功能。
- 不動 `endfield-live` 資料夾（舊部署鏡像，之後由使用者決定是否刪除）。

**做了就算失敗的事**
- 任何使用者的抽卡紀錄、綁定帳號、自動簽到設定遺失或損毀。
- 未經使用者明確同意就重啟或更新正式環境。
- 改動卡片的外觀（除非該工作項明說）。

## 4. 做法的選擇

考慮過三種：

- **A. 照風險順序在現有大檔上直接修，最後才拆檔。** 漏洞最快關掉，但抽卡相關的修正全擠在 `gacha.ts`／`gachaLogUtils.ts`／`gachaCanvasUtils.ts` 三個檔，同一時間只能有一個 Sonnet 動抽卡，平行度最差。
- **B. 先拆抽卡三大檔，同時平行處理抽卡以外的所有事；拆完後抽卡的修正再平行。**（採用）抽卡的漏洞會晚一輪才修，但拆檔是純搬移、約一輪就完成，之後抽卡可以同時開 4 條線。
- **C. 效能優先，先重做抽卡紀錄的儲存結構。** 效益最大，但就是上面「這次不做」的那個不可逆遷移。

採用 B：使用者把「怎麼做」交給主 session 決定，B 是平行度與風險的最佳平衡。

## 5. 工作方式

- 整合分支 `opt/2026-11`，從 `main` 開出。每條線一個分支 `opt/<lane>` + 自己的 git worktree（放在 OneDrive 之外，例如 `C:\wt\endfield-<lane>`，避免同步干擾）。
- **每條線擁有固定的一組檔案，不碰別條線的檔案。** 需要動到別人的檔案時回報主 session，不要自己改。
- 每條線交付前必須：`npx tsc --noEmit` 通過、`yarn test` 通過、為自己修的每個行為補上或更新測試（沿用現有 `node:assert` 風格的 `*.test.ts`）。
- 主 session 讀 diff 驗收後合併進 `opt/2026-11`。每一波結束後再合併到 `main`（commit 與 push 需使用者同意）。
- 不新增 npm 依賴，除非該工作項明說。
- 字串一律走 `tr()`，en 與 tw 兩份語言檔都要補。語言檔是所有線共用的：**只能在檔案結尾自己那一線的註解區塊（第 0 波會預先放好 `// --- <lane> ---` 標記）內新增 key，不改、不搬既有的 key**；合併衝突由主 session 處理。
- `package.json` 只有第 0 波能改。
- 需要資料庫新能力時只用第 0 波提供的 helper；不夠用就回報，不要自己改 `Database.ts`（第 1 波起它屬於 L4，且 L4 只改 `findByPrefix` 的內部實作）。
- 需要「啟動時跑一次」或「定時跑」的工作，一律用第 0 波提供的啟動掛鉤註冊，不直接改 `index.ts`／`ready.ts`。
- UI 遵循使用者既有偏好：有圖示就用圖示＋少量文字；清單要能搜尋／篩選／排序。

**部署（每次都要使用者明確同意才執行）**
1. 每次部署前：把 Mac 上的 `src` 與「上次部署的 commit」比對，確認線上沒有未入庫的改動；有的話先帶回 repo。（2026-11-19 已比對過一次，結果見第 2 節。）
2. 備份 Mac 的 `src`＋`dist`；凡是會改資料形狀的部署，先用 `sqlite3 .backup` 備份 `json.sqlite`。
3. 以 `git archive` 傳送變更檔，在 Mac 上 `tsc --noEmit`，`pm2 restart endfield`，讀 log 確認 5 個 cluster 都 ready。
4. 資料遷移一律寫成「可重複執行、舊資料保留不刪」的啟動時遷移；確認新資料正確後，下一次部署才清舊資料。

## 6. 工作項

### 第 0 波（一個 Sonnet，先做完並合併，其他線才從它開分支）

共用地基，讓後面各線不必互相踩檔：
- `package.json` 加 `test` script，一次跑完所有 `src/**/*.test.ts`；測試檔不再編進 `dist`。先確認現有 19 個測試在乾淨的 checkout 上哪些通過、哪些本來就失敗，列在報告裡。
- `Database.ts` 新增 helper（既有 API 不變）：帶 TTL 的 `setWithTtl`／`getFresh`、`deleteByPrefix`、以同步 transaction 包住的 `update(key, fn)`（原子讀改寫）、程序內的 `withKeyLock(key, asyncFn)`。
- 啟動掛鉤：`client.startup.onPrimary(name, fn)`（只在 cluster 0、ready 後跑一次）與 `client.startup.every(name, ms, fn)`（只在 cluster 0 定時跑），在 `index.ts`／`ready.ts` 接好。
- `commandHandler.ts`：單一指令檔載入失敗只記錄、不拖垮啟動；沒有 `default.data` 的檔案略過並警告。
- 兩個語言檔結尾放好各線的標記區塊。
- 驗收：`tsc --noEmit` 與 `yarn test` 通過，bot 行為零變動。

### 第 1 波（5 條線同時進行，檔案互不重疊）

**L1 抽卡拆檔**（純搬移，行為零變動）
- `src/commands/general/gacha.ts` 留在原位，變成薄的分派器；內容搬到 **`src/features/gacha/`**（不在 `src/commands` 底下）：builder、accounts、load、view、leaderboard、maintenance、simulate、list、autocomplete。重複三次的 linkedAccount 查找（原 :489、:1640、:1959）收斂成一個函式。
- `src/utils/gachaLogUtils.ts` → gachaTypes、gachaApi、gachaFingerprint、gachaStore、gachaLeaderboard、gachaStatsEngine。原檔保留為 re-export，讓其他檔案的 import 不用改。
- `src/utils/gachaCanvasUtils.ts` → iconLoader、gachaStatsCanvas/{summary,overview,detail}＋共用 helper。原檔同樣保留 re-export。
- 驗收：既有測試全過；改前改後用同一份假資料渲染的統計卡相同。渲染比對只用本機素材（遠端圖示以固定的替身圖取代，不連網）；若 PNG 編碼不保證逐位元一致，改比對解碼後的像素。

**L2 網頁與憑證安全**（`src/web/*`、`cryptoUtils.ts`、`events/messageCreate.ts`、`commands/account/login.ts`、`commands/general/profile.ts` 的 token 部分）
- 圖片代理：只允許白名單主機（SKPort／Gryphline／Hypergryph 的靜態資源網域）、只收 image/* 、加逾時與大小上限、副檔名由內容型別決定、快取加總量上限與淘汰。
- 編輯器 token 與驗證 sessionId 改用 `crypto.randomBytes`；請求 log 遮蔽 token；過期的 `profile_edit_token:*` 定期清除；`dataCache` 加淘汰。
- `encrypt()` 失敗就拋錯；沒有 `ENCRYPTION_KEY` 時 bot 拒絕啟動（Mac 已設定此金鑰）。`decrypt()` 對舊的明文資料只維持讀取相容，不做批次遷移。
- `WebManager.ts:171` 與 `profile.ts:308` 改用 L3 的新函式這件事不在本線做，見 L3。
- 擁有者除錯指令不再輸出 `cred`／`salt`／`cookie` 明文（遮蔽成前後各 4 碼）。`skportApi.ts:873` 記錄完整 token 的那行同樣遮蔽——此檔屬 L3，由 L3 處理。
- CORS 收斂到自己的網域；`/callback`、`/api/preview` 加基本限流；preview 的 body 上限下修、錯誤訊息不外洩。
- **跨 cluster 驗證碼登入**：`/callback` 把結果寫進資料庫（`captcha_result:<sessionId>`，短 TTL），發起 `/login` 的 cluster 以輪詢讀取；`VerificationClient` 的計時器與 listener 清理一併修正。

**L3 簽到與帳號**（`services/AutoDailyService.ts`、`commands/general/daily.ts`、`utils/attendanceUtils.ts`、`utils/accountUtils.ts`、`utils/skportApi.ts`、`commands/general/indieHard.ts`）
- 自動簽到：成功後才標記當日完成；失敗的人在當天後續每小時重試；bot 停機錯過的時段，啟動後補跑。
- 失敗如實顯示失敗原因，不再顯示成「已簽到」。
- token 無法恢復時，不論 `notify` 設定都私訊一次請使用者重新 `/login`（同一帳號不重複轟炸：記錄已通知，重新登入後清除）。
- 帳號 token 更新加每帳號鎖，避免簽到與提醒同時刷新互相覆寫。
- **binding roles**：新增共用的綁定正規化工具，取代 `daily.ts:571` 與 `AutoDailyService.ts:92` 的重複實作；終末地（gameId 3）綁定若 `roles` 為空，由綁定本身的 `uid`／`nickName`／`channelMasterId` 合成角色。**不改 `getPrimaryBindingRole` 的簽名**（別條線的檔案也在呼叫它，改了會讓它們編譯失敗）：新增 `getPrimaryBindingRoleForGame(…, gameId)`，舊函式標記 `@deprecated` 保留。本線把自己檔案裡的呼叫點（`indieHard.ts:72`、`:199`、`accountUtils.ts:137`）換成新函式；其餘呼叫點（`gacha.ts:1713`、`WebManager.ts:171`、`profile.ts:308`）由主 session 在第 1 波全部合併後一次換掉，之後刪除舊函式。以被 revert 的 2dd055e 的測試案例為回歸測試。**先查清楚那兩個 commit 為什麼被 revert**（讀 diff，找出會壞的情境），在報告裡說明新做法如何避開。
- `indieHard.ts` 的請求補上 `onStale` 自動刷新。

**L4 新聞、提醒與基礎效能**（`services/SkportNewsService.ts`、`commands/general/news.ts`、`commands/general/reminder.ts`、`services/MonitorService.ts`、`utils/reminders.ts`、`utils/reminderWizard*.ts`、`events/ready.ts`、`events/interactionCreate.ts`、`cluster.ts`、`index.ts`、`structures/Client.ts`、`utils/Database.ts`、`optimizations/`、`utils/shared*.ts`、`commands/admin/*`）
- 新聞：私訊訂閱真的送出；發送成功後才記錄；失敗的頻道重試，永久性錯誤（頻道已刪、無權限）才移除訂閱；一次輪詢不再只取 3 則；`news_subscriptions` 從單一陣列改成每訂閱一列（啟動時遷移）；`news_dispatch.*` 只保留近 90 天。
- 提醒：同一帳號多個角色共用一次 `card/detail` 請求；重試間隔不可長於提醒的提前量；舊 `monitorConfig` 訂閱者在啟動時自動轉成 v2 規則。
- `/reminder list`：列出自己的提醒規則，可逐條暫停／刪除（原本規劃在 L5，因為 `/reminder` 的檔案都屬本線而移過來）。
- 指令只由 cluster 0 註冊（全域註冊，維持現狀），且只在指令定義改變時才註冊：把所有指令的 `data.toJSON()` 依名稱排序後取 SHA-256，與資料庫 `commands_hash` 比對，不同才 `rest.put` 並更新雜湊。狀態列更新改為只由 cluster 0 每分鐘一次。
- `cluster.ts` 重複累加的計時器、未 await 的 login、`uncaughtException` 後繼續跑（改為記錄後讓 cluster 退出，由 manager 重生）、錯誤 webhook 加節流。
- `/language` 改完立即清掉該使用者的語言快取；按鈕與 modal 出錯時回覆使用者；單一指令檔載入失敗不拖垮啟動。
- `Database.findByPrefix` 改成能用主鍵索引的範圍查詢（`ID >= ? AND ID < ?`），並正確處理 `_`／`%`。
- 刪除從未被呼叫的 `optimizations/` 與 `sharedCompat.ts`、兩個 `.disabled` 檔中的 `monitor.ts.disabled`、其他已確認的死碼。改為在 `interactionCreate` 加一個真的會生效的每使用者限流（記憶體內、會淘汰）。

**L5 低成本新功能 A**（只新增檔案＋語言檔自己的區塊；指令放進 `src/commands/general/` 就會自動載入，不需要改任何清單。唯一動到的既有檔是 `crisisContract.disabled` 與 `crisisContractCanvasUtils.ts`）
- `/stamina`：即時理智、回滿時間、每日活躍、週常進度，一張卡。多帳號用圖示選單切換。
- 危機合約指令重新啟用：`crisisContract.disabled` → `.ts`，賽季 ID 從 `card/detail.crisisContract[].id` 取得、在地化、拿掉 JSON 附件、支援多帳號與 gameId 過濾。
- 兩個指令都需要「取終末地角色」：先自己用 gameId 3 過濾綁定，等 L3 的 `getPrimaryBindingRoleForGame` 合併後由主 session 換過去。

### 第 2 波（L1 合併後；4 條線同時進行，各自擁有拆出來的檔案）

**G1 抽卡安全**（gacha/maintenance、gacha/view、gacha/load、gachaApi）
- `clear`、`view account:` 與所有確認按鈕都驗證 UID 屬於操作者（或是公開分享的他人紀錄且僅限讀取）。
- 所有翻頁／選單元件驗證操作者；看別人的紀錄不得更新排行榜資料。
- 貼上的網址只接受官方 API 主機白名單。
- `PENDING_GACHA_URL_*`、fingerprint 暫存加 TTL 並加密。
- 所有匯入請求加逾時；匯入時抓到已存在的 seqId 就停（增量匯入）；武器池中途失敗要明確告知使用者紀錄不完整。

**G2 排行榜與儲存**（gachaLeaderboard、gachaStore、gacha/leaderboard、gachaLeaderboardCanvasUtils）
- 排行榜從單一 6.9MB blob 改成每 UID 一列（`GACHA_LB.<uid>`），啟動時由舊 blob 遷移，舊 blob 先保留。
- 排行榜只在匯入後更新，看統計時不寫入。
- 出貨率分子分母口徑一致（都排除免費抽）；幸運排序加最低抽數門檻（主 session 定為 100 抽）；可翻頁；可切換「全域／本伺服器」。「本伺服器」的名單來源：使用者在某伺服器執行過 `/gacha log load` 或 `view`（看自己的）時，把該 guildId 記進他的排行榜列；不去查成員名單。上線前沒有歷史資料，名單會隨使用逐漸長出來，這點要在介面上用一行小字說明。
- 重新匯入時保留 `charPityResetSeqId`／`weaponPityResetSeqId`。
- `GACHA_POOL_NAMES`、模擬器卡池紀錄的讀改寫包進 transaction。

**G3 統計正確性與快取**（gachaStatsEngine、gachaPoolUtils）
- `getGachaStats` 的結果快取到資料庫另一列（`GACHA_STATS.<uid>`），看統計與翻頁直接讀快取，不再 parse 整筆紀錄。失效方式：快取列帶 `ENGINE_VERSION`（定義在 gachaStatsEngine，改演算法就加一）與來源紀錄的 `updatedAt`；任何寫入抽卡紀錄的地方（匯入、清除、遷移，都在 G2 的 gachaStore）寫入時更新 `updatedAt`。G3 讀取時兩者任一不符就重算。G2 與 G3 之間只靠這個欄位約定，不互相改檔。
- 未知的 6★ 不再預設為 UP：以卡池中繼資料為準，查不到時標示「未知」並不計入不歪率。
- Joint 卡池計入限定池總覽（先寫測試確認這是否真的是 bug）。
- 卡池選單超過 24 個時分頁，舊卡池可達。

**G4 繪圖效能**（iconLoader、gachaStatsCanvas/*、gachaSimulatorUtils、canvasUtils 的 `fetchImage`）
- 圖示與背景解碼後進 LRU 快取；本機圖示路徑在啟動時建索引，不再每次試 12 個候選路徑。
- 成品卡片以（統計快取鍵, 檢視參數, 語言）為鍵快取 PNG（記憶體 LRU，有總量上限），翻回看過的頁面不重畫。
- 拿掉每次渲染多打的一次無逾時 `fetch`；模擬器角色圖平行載入。
- 新角色／武器圖示：寫死的對照表查不到時，退回用 wiki 資料的圖示網址，不必改程式碼。

### 第 3 波（新功能 B，平行；細節在第 2 波結束時依當時狀況再定）
- 簽到月曆（`getAttendanceRecords`）。
- 基建／據點滿倉提醒（接進 `/reminder` 精靈）。
- 武器池模擬器。
- 抽卡紀錄匯出（JSON）。
- `/gacha list` 顯示武器池。
- 新聞語言跟隨訂閱者語言。

## 7. 如何確認有變快

第 1 波開始前，由主 session 在本機用一份脫敏的大型抽卡紀錄（模擬 2MB 等級）建立基準：
看統計、翻頁、匯入、排行榜各自的耗時。第 2 波結束後重測，結果寫進合併報告。
目標：翻回看過的頁面 < 300ms、首次看統計不 parse 原始紀錄、看統計時資料庫零寫入。

## 8. 交給實作者決定的事

- 檔案內部的函式命名與切法（在第 6 節指定的檔案邊界之內）。
- 快取大小、TTL、限流數值的具體數字（選保守值並在報告中列出）。
- 新指令卡片的版面（沿用現有卡片的視覺語言與 `canvasUtils` 的工具）。

## 9. 主 session 自己做的決定（使用者可推翻）

- 採用做法 B。
- 不做抽卡紀錄的正規化遷移。
- 幸運排行最低 100 抽。
- `news_dispatch` 保留 90 天。
- `uncaughtException` 後讓 cluster 退出重生。
- 新功能第一批選 `/stamina`、危機合約、`/reminder list`。
- 先做一個「第 0 波」把共用地基鋪好，各線才開工。
- 抽卡拆出來的檔案放 `src/features/gacha/`。
- 「本伺服器」排行榜的名單靠使用紀錄累積，不查成員名單。
- 語言檔採「各線只在自己的結尾區塊新增」的規則。
- 效能基準用的大型假抽卡紀錄由主 session 產生。
- 本機驗證以 `tsc`＋單元測試＋離線渲染卡片為主；需要真 Discord 互動的部分在部署到 Mac 後由使用者實測。
