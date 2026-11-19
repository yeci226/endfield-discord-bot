# 兩個「binding roles」修正為何被 revert（L3 調查筆記）

日期：2026-11-19　調查者：L3 lane　範圍：`git show 90001a8 2dd055e 9a93d8d 4ebb0f6`

**先講結論的可信度：沒有任何人記錄過 revert 的原因。commit message 只有 "Revert ..."，repo 裡也沒有 issue、PR 或筆記。下面分「diff 能直接證明的事實」與「我的推論」兩段；推論不能當成已確認的根因。**

## A. 從 diff 與 git 紀錄能確認的事實

時間線（皆為 +0800，2026-07-20）：

| commit | 時間 | 內容 |
|---|---|---|
| `12cc5fc` | 前一天 23:55 | 上一個綁定相關修改（`ensureAccountBinding` 的「近期且有角色就略過」改成「有 primary role 或 Arknights 綁定」、binding API 多帶 `account.info.id`）。**這個仍在 main。** |
| `90001a8` | 00:22 | 新增 `attendanceBindingUtils.ts`，把 `daily.ts` 與 `AutoDailyService.ts` 兩份重複的 `normalizeAttendanceBindings` 合一；`roles` 為空且有 `uid`/`nickName` 時，**gameId 3 也合成角色**（原本只合成 gameId 1）。 |
| `2dd055e` | 03:01 | 標 `[verified]`。新增 `bindingRoleUtils.ts`（`normalizeBindingRoles` / `findPrimaryBindingRole` / `resolveBindingUid` / `selectAccountByIndex`），並改動 12 個檔：`login`、`daily`、`gacha`、`indieHard`、`profile`、`MonitorService`、`accountUtils`、`WebManager`。 |
| `9a93d8d`、`4ebb0f6` | 03:19:43（同一秒） | 兩個 revert 同時產生，即 `2dd055e` 上線後 18 分鐘。 |

`2dd055e` 實際改變的行為（直接來自 diff）：

1. **所有未帶 gameId 的 `getPrimaryBindingRole(bindings)` 呼叫點改成 `getPrimaryBindingRole(bindings, 3)`**（profile、monitor、indieHard、gacha、web editor），也就是只認終末地綁定。
2. **送給 `card/detail` 的 `userId` 參數改變來源**：`profile.ts`、`MonitorService.ts`、`WebManager.ts` 原本是 `account.info?.id`（SKPort 帳號 id），改成 `resolveBindingUid(...)` = `binding.uid || role.roleId || role.uid || account.info.id`，也就是**優先用綁定的 uid**。測試斷言明寫「binding uid must take precedence over the SKPort account id」。對已經有巢狀 `roles`、本來就能正常運作的使用者，這一行會改變送出的 API 參數。
3. **`normalizeBindingRoles` 對任何遊戲都合成角色**（不檢查 gameId），只要有 `uid` 或 `nickName`；合成角色的 `roleId` 可能是空字串（只有 `nickName` 時）。`ensureAccountBinding` 的快取略過條件因此變成「`getPrimaryBindingRole(account.roles)` 為真」，只要帳號有任何帶 uid 的綁定就永遠略過重新驗證。
4. `profile` 的 `char_select` customId 結尾多了 `:${accountIndex}`、其中的 `uid` 欄位語意也由帳號 id 變成綁定 uid；舊訊息上的選單 customId 是舊格式。
5. 測試 fixture 把期望順序由 `[3, 1]` 改成 `[1, 3]`（fixture 中 AK 綁定在前）。
6. `gacha.ts` 的 EF 角色列表改成只收 `gameId === 3` 的綁定。
7. `2dd055e` 修改的 `attendanceBindingUtils.ts` 與其測試是 `90001a8` 建立的，所以兩者是堆疊關係；`90001a8` 單獨存在時沒有被證明有問題。

另外確認：目前 main（45075bf）兩個修正都不在；2026-11-19 實測 Mac 上的 `src` 與 main 只差 gacha 兩個檔，所以這兩個修正**不在正式環境**。**這份調查無法得知它們曾不曾被部署過**（若曾部署，18 分鐘內被撤回，正式環境不會留下痕跡）。

## B. 我的推論（未證實）

按可能性排序，每一項都是「會壞的情境」而不是已觀察到的故障：

1. **（我認為最可疑）API 參數的悄悄改變。** 第 2 點讓 profile／monitor／web 對「原本正常」的使用者改送另一個 id。`indieHard.ts` 原本就送 `binding.uid`，其他地方送 `account.info.id`，兩者在 repo 裡並存，沒有任何註解說明哪個才是 `card/detail` 要的。若 SKPort 其實要的是帳號 id，所有人的個人檔案、提醒、網頁編輯器會在上線後立即回空資料／失敗，18 分鐘內就會被發現。這也解釋為何兩個一起 revert（來不及分辨）。
2. **範圍太大、沒有分層。** 一個 commit 同時改了 12 個檔、7 種行為（見上），其中「合成終末地角色」是個純增量修正，卻與「改變 uid 來源」「硬性只認 gameId 3」綁在一起，出問題時只能整包撤回。
3. **無 gameId 檢查的合成角色**（第 3 點）：`roleId` 為空字串的角色會被送進 API；`ensureAccountBinding` 因此不再重新驗證有問題的帳號。
4. **舊的 `profile:char_select` 選單**（第 4 點）在 revert 後與舊程式格式相同，不構成撤回理由，僅列為風險。
5. 合成的終末地角色一旦上線，`game_scope` 為預設 `both` 的自動簽到使用者會**第一次**對終末地簽到並收到多一張卡片（這是預期效果，但規模是約 5,000 人同時改變行為）。

## C. 新做法如何避開（L3 的設計，見 `src/utils/bindingRoles.ts`）

- **只新增合成、不改既有選擇。** 凡是綁定已經有非空 `roles`（或 `defaultRole`）的使用者，回傳的 `roleId`／`serverId`／`nickname` 與原本逐字相同，`raw` 就是原本的角色物件；因此已存的 `autoDaily.*`（只存 `game_scope`、時間、通知設定，不存角色）與下游以 `roleId`+`serverId` 為 key 的資料（簽到去重、`EF_<uid>` 抽卡紀錄）解析到同一個角色。合成只發生在 `roles` 為空且 `defaultRole` 為空時。**更正：這不代表「原本沒有角色」——`daily.ts` 與 `AutoDailyService.ts` 目前就已對 gameId 1 合成角色**（`roleId=uid`、`serverId=channelMasterId`、`nickname=nickName||uid||"Arknights"`、`level:0`、`serverName=channelName||gameName||"-"`），生產形狀的 fixture（AK 綁定 `roles: []`、`defaultRole: null`）正是這種情況。所以新工具對 gameId 1 必須逐欄位產生與舊函式完全相同的物件（`raw` 即該物件），測試以舊函式輸出作對照。只有 gameId 3 的合成與 `roles: []` 但 `defaultRole` 非空這兩種是**新解析出來**的（舊程式先判斷 `Array.isArray(entry.roles)`，空陣列就不會看 `defaultRole`），這兩類使用者原本在簽到流程中得不到角色。
- **一定要指定 gameId**：`normalizeBindingRoles(bindings, gameIds)` 只處理列出的遊戲，沒有「任意遊戲」的合成。沒有 uid 也沒有 id 的角色不輸出（不產生空 `roleId`）。
- **不改任何 API 的 `userId` 來源。** 本 lane 的 `indieHard` 維持 `binding.uid || account.info.id`（原樣）；`profile`／`MonitorService`／`WebManager` 不在本 lane，**不動它們送的 id**，之後換呼叫點時也只換「選角色」那一步。這點我無法驗證哪個 id 才對，列入「需要線上驗證」。
- **舊函式保留**：`getPrimaryBindingRole(bindings)` 簽名不變、標 `@deprecated`，其他 lane 不受影響；回歸測試把 `2dd055e` 的生產形狀 fixture（AK 在前、終末地 `roles: []` 且 `defaultRole: null`）原樣收入。
- **分層提交**：先只加工具與測試，再換呼叫點，每一步獨立 commit，將來要撤回可以只撤一層。

## D. 2026-11-19 production measurement（正式資料庫唯讀查詢）

- 終末地（gameId 3）有角色的綁定共 7,216 筆。**每一筆**都是 `binding.uid !== roles[0].roleId` 且 `binding.channelMasterId !== roles[0].serverId`。
- 終末地綁定但 `roles: []` 的有 176 筆（其中 106 筆屬於自動簽到使用者），沒有任何一筆有 `defaultRole`。這些是「綁了終末地、但沒有可用角色」的帳號。
- 明日方舟（gameId 1）綁定 2,436 筆，**全部** `roles: []` 且帶有 `uid` + `channelMasterId`；用綁定合成角色是那邊長年正常運作的行為。
- 已被標成 `invalid: true` 的帳號 782 個（526 個屬於自動簽到使用者）。
- 自動簽到範圍：arknights 2,096／endfield 1,805／both 1,174。

**結論：** 終末地的 roleId／serverId 不能由綁定的 `uid`／`channelMasterId` 合成；那樣會把錯的 roleId／serverId 送給 API。第 C 節（以及 `2dd055e`、`90001a8`）曾假設「`roles: []` 的終末地綁定可以用 uid 合成角色」，這個假設被上述數字否定。這**很可能**就是先前兩個修正被撤回的原因之一（仍是推論：commit 沒有記錄原因）。

因此 `bindingRoles.ts` 現在只對 gameId 1 合成角色；gameId 3 且 `roles: []`、沒有 `defaultRole` 時回傳「沒有角色」。自動簽到遇到「範圍內完全沒有角色」的帳號：不算錯誤、不重試、不 DM，只留一行 debug log（`both` 且只有明日方舟有角色時，只簽明日方舟並收為 done）。手動 `/daily game:終末地` 則回覆「這個帳號沒有綁定終末地角色」。`endfieldRole.ts` 已刪除，`/stamina`、`/crisis-contract` 改用 `bindingRoles.ts`（它們送給 API 的 `userId` 仍是 SKPORT 帳號 id，沒有改）。
