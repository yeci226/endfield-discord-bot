<div align="center">

<!-- Replace with your banner image -->
<img src="src/assets/profiles/1.png" alt="Banner" width="50%" />

<br />
<br />

# Endfield Discord Bot

**專為 明日方舟：終末地 打造的 Discord 機器人**

[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-ISC-blue?style=flat-square)](LICENSE)

<br />

[English](README.md) | **繁體中文**

<br />

<!-- Replace with a real screenshot or GIF of your bot in action -->
<img src="src/assets/readme/demo.gif" alt="Bot Demo" width="80%" />

</div>

---

## 功能特色

| 功能           | 說明                             |
| -------------- | -------------------------------- |
| **抽卡模擬器** | 依照終末地卡池機率模擬抽卡       |
| **抽卡紀錄**   | 同步並查看遊戲內的抽卡歷史       |
| **每日簽到**   | 領取每日獎勵並追蹤出勤連續天數   |
| **玩家名片**   | 以精美視覺呈現你的終末地玩家資訊 |
| **最新消息**   | 即時掌握終末地官方最新公告       |
| **帳號綁定**   | 綁定終末地帳號以獲取個人化資料   |
| **自動簽到**   | 每日自動替你完成簽到             |
| **多語言支援** | 支援繁體中文與英文               |

---

## 快速開始

### 環境需求

- [Node.js](https://nodejs.org) v18+
- [Yarn](https://yarnpkg.com)
- Discord Bot Token

### 安裝

```bash
# 複製儲存庫
git clone https://github.com/your-username/endfield-discord-bot.git
cd endfield-discord-bot

# 安裝依賴
yarn install

# 複製並設定環境變數
cp .env.example .env
```

### 設定

編輯 `.env` 填入你的憑證：

```env
DISCORD_TOKEN=你的_Discord_Bot_Token
CLIENT_ID=你的_Discord_應用程式_ID
# ... 其他設定值
```

### 啟動

```bash
# 開發模式（熱重載）
yarn dev

# 正式環境
yarn start
```

---

## 指令列表

### 一般

| 指令        | 說明                         |
| ----------- | ---------------------------- |
| `/gacha`    | 開啟抽卡模擬器或查看抽卡紀錄 |
| `/daily`    | 領取每日簽到獎勵             |
| `/profile`  | 查看你的終末地玩家名片       |
| `/news`     | 瀏覽最新終末地消息           |
| `/language` | 切換偏好語言                 |

### 帳號

| 指令     | 說明               |
| -------- | ------------------ |
| `/login` | 綁定你的終末地帳號 |

### 管理員

| 指令               | 說明                 |
| ------------------ | -------------------- |
| `/movedailynotify` | 移動每日簽到通知頻道 |

---

## 截圖預覽

<div align="center">

<!-- Replace these placeholders with actual screenshots -->

<img src="src/assets/readme/screenshot-newsfeed.png" width="600" alt="官方新聞" />
<br /><sub><b>官方新聞</b></sub>

<br /><br />

<img src="src/assets/readme/screenshot-profile.webp" width="600" alt="玩家名片" />
<img src="src/assets/readme/screenshot-profile-char.webp" width="600" alt="玩家名片" />
<br /><sub><b>玩家名片</b></sub>

<br /><br />

<img src="src/assets/readme/screenshot-daily.webp" width="600" alt="每日簽到" />
<br /><sub><b>每日簽到</b></sub>

<br /><br />

<img src="src/assets/readme/screenshot-records.webp" width="600" alt="抽卡紀錄" />
<br /><sub><b>抽卡紀錄</b></sub>

</div>

<img src="src/assets/readme/screenshot-gacha.png" width="600" alt="玩家名片" />
<br /><sub><b>模擬抽卡</b></sub>

<br /><br />

---

## 技術棧

- **[Discord.js v14](https://discord.js.org)** — Discord API 框架
- **[TypeScript](https://www.typescriptlang.org)** — 型別安全的 JavaScript
- **[@napi-rs/canvas](https://github.com/Brooooooklyn/canvas)** — 高效能圖像生成
- **[Better SQLite3](https://github.com/WiseLibs/better-sqlite3)** — 本地資料庫
- **[Express](https://expressjs.com)** — 內部 OAuth 驗證伺服器
- **[discord-hybrid-sharding](https://github.com/meister03/discord-hybrid-sharding)** — 分片支援

---

## 貢獻

歡迎提交 Issue 或 Pull Request！

---

<div align="center">

為 明日方舟：終末地 社群用心打造

</div>
