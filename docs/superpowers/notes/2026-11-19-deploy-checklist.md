# 上線檢查清單（`opt/2026-11` → Mac）

整合 commit：`84dec39`（`tsc` 通過、建置通過、測試 74 通過 / 0 失敗）。
正式環境：Mac `~/Desktop/bots/endfield`，pm2 app `endfield`，5 個 cluster，不是 git repo。
目前線上版本：`main` 的 45075bf 減去 11/17「連結帳號 401」修正。

## 上線前（已查證，2026-11-19）

- [x] `ENCRYPTION_KEY` 長度 64，符合新的啟動檢查（不足 16 會讓所有 cluster 起不來）。
- [x] 用現有金鑰解不開的帳號憑證：0 / 7,521。
- [x] 近期 pm2 log 的 Uncaught Exception：0 次（新版遇到會讓該 cluster 退出重生）。
- [x] Mac 上的 `src` 沒有 repo 以外的改動。
- [ ] 編輯器網域：`.env` 的 `EDITOR_PUBLIC_URL`、`VERIFY_HUB_URL` 目前仍是 `editor.yeci.lol`；`editor.yeci.it.com` 尚無 DNS。要換網域時由擁有者處理 DNS／tunnel 與 `.env`。程式已不依賴網域（自家 `/assets` 連結一律讀本機檔）。

## 上線步驟（每一步都需要擁有者同意）

1. 備份：`sqlite3 json.sqlite ".backup '<備份路徑>/json-pre-opt-2026-11.sqlite'"`（約 900MB）；打包 `src`＋`dist`。
2. 傳送：`git archive opt/2026-11 src scripts package.json tsconfig.json tsconfig.build.json | ssh … tar xf -`。**先刪除 Mac 上已不存在於 repo 的舊檔**（`src/optimizations/`、`src/utils/sharedCompat.ts`、`src/commands/general/*.disabled`、`src/commands/general/*.bak-*`、`src/utils/*.bak-*`、`src/utils/*.before-*`、`src/scripts/`），否則 `tsc` 會把它們一起編進去。
3. 在 Mac 上先跑 `node_modules/.bin/tsc -p tsconfig.build.json --noEmit`，通過才繼續（`yarn start` 會再建置一次，建置期間 bot 離線約一分鐘）。
4. `pm2 restart endfield`，看 log 直到 5 個 cluster 都 ready。

## 上線後第一小時要看的

- **抽卡按鈕（最優先）**：自己執行 `/gacha log view`，按翻頁與卡池選單。按鈕的「只有發起者能按」依賴 Discord 附在訊息上的發起者資訊，只用假資料測過；若判斷錯，所有抽卡按鈕都會失效。再請另一個帳號去按，應只收到僅自己可見的提示。
- log 中應出現：指令註冊一次（13 個指令）、`GACHA_LB_MIGRATED` 寫入、沒有「Image host not allowed」、沒有重複的舊新聞被發出。
- 自動簽到第一輪：已被舊版簽過的人不應再收到卡片；cluster 0 不應因卡住而被重啟。
- `/stamina`、`/crisis-contract`、`/reminder list`、`/gacha log leaderboard`（翻頁、我的名次、全球／本伺服器、關閉）各試一次。
- 名片編輯器：開啟既有名片，圖片應全部顯示；存檔成功。
- `/login` 的驗證碼流程走一次（跨 cluster 改用資料庫傳遞結果）。
- `/gacha list` 後看 `GACHA_ICON_URLS` 是否同時有角色與武器的項目。
- 觀察每個 cluster 的 RSS 數小時（圖片快取上限 256MB、卡片快取 64MB、統計快取約 200MB，皆為每個程序各自計算）。

## bot 上線後會自己做的事

- 排行榜：舊資料分批搬到每人一列（不到 1 秒），之後每 30 秒修正 10 筆舊的出貨率，全部修完即停。
- 新聞：超過 24 小時的舊聞標記為已讀不補發；31 位私訊訂閱者只會收到搬移之後發布的新聞；10 萬筆舊發送紀錄每小時清 2,000 筆（約 2 天）。
- 舊版提醒：223 筆舊設定轉成**暫停中**的規則，不會自己發送；擁有者在 `/reminder list` 可恢復。
- 「登入過期」私訊：第一小時不會發；之後每小時最多 40 則（現有 526 位自動簽到使用者的帳號已失效）。
- 過期的編輯 token（863 筆）與 30 天未用的統計快取，一小時後開始清。

## 退回舊版

1. 還原 `src`＋`dist` 備份，`pm2 restart endfield`。資料庫**不需要**還原。
2. 刪除 `commands_hash` 這一列（否則之後再升級時新指令不會被註冊）。
3. 之後若要再升級，先刪除三個搬移標記：`migration.news_sub.v1`、`migration.reminder_v2.v1`、`GACHA_LB_MIGRATED`（以及 `GACHA_LB_REFRESHED_V2`）。
4. 退回的副作用：新版期間新增的新聞訂閱會消失、取消的會復活；當天簽到失敗或重試中的使用者會被舊版再簽並再通知一次；新版期間的排行榜更新不會出現在舊版排行榜。抽卡紀錄與帳號資料不受影響。

## 尚未做（第 3 波候選）

簽到月曆、基建／據點滿倉提醒、武器池模擬器、抽卡紀錄匯出、新聞語言跟隨訂閱者、統計快取命中時仍有約 30ms 的同步解析。
