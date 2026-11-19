import { SlashCommandBuilder } from "discord.js";

export const gachaCommandData = new SlashCommandBuilder()
    .setName("gacha")
    .setNameLocalizations({
      "zh-TW": "抽卡",
    })
    .setDescription("Gacha related commands")
    .setDescriptionLocalizations({
      "zh-TW": "抽卡相關指令",
    })
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setNameLocalizations({
          "zh-TW": "卡池列表",
        })
        .setDescription("Display current character and weapon pools")
        .setDescriptionLocalizations({
          "zh-TW": "顯示當前的角色池以及武器池",
        }),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("log")
        .setNameLocalizations({
          "zh-TW": "紀錄",
        })
        .setDescription("Gacha log related commands")
        .setDescriptionLocalizations({
          "zh-TW": "抽卡紀錄相關指令",
        })
        .addSubcommand((sub) =>
          sub
            .setName("how")
            .setNameLocalizations({
              "zh-TW": "如何獲取",
            })
            .setDescription("How to get gacha log URL")
            .setDescriptionLocalizations({
              "zh-TW": "如何獲取抽卡紀錄網址",
            }),
        )
        .addSubcommand((sub) =>
          sub
            .setName("simulate")
            .setNameLocalizations({ "zh-TW": "模擬抽卡" })
            .setDescription("Simulate gacha pulls with accurate pity mechanics")
            .setDescriptionLocalizations({
              "zh-TW": "以準確機率與保底機制模擬招募/尋訪",
            })
            .addStringOption((opt) =>
              opt
                .setName("banner")
                .setNameLocalizations({ "zh-TW": "卡池" })
                .setDescription("Select banner")
                .setDescriptionLocalizations({
                  "zh-TW": "選擇卡池",
                })
                .setAutocomplete(true)
                .setRequired(false),
            )
            .addIntegerOption((opt) =>
              opt
                .setName("count")
                .setNameLocalizations({ "zh-TW": "抽數" })
                .setDescription("Number of pulls (1 or 10, default: 10)")
                .setDescriptionLocalizations({
                  "zh-TW": "抽卡次數（1次或10連，預設：10連）",
                })
                .addChoices(
                  { name: "1次", value: 1 },
                  { name: "10連", value: 10 },
                )
                .setRequired(false),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("load")
            .setNameLocalizations({
              "zh-TW": "載入",
            })
            .setDescription("Load gacha log from linked account")
            .setDescriptionLocalizations({
              "zh-TW": "從綁定帳號載入抽卡紀錄",
            })
            .addStringOption((option) =>
              option
                .setName("account")
                .setNameLocalizations({
                  "zh-TW": "帳號",
                })
                .setDescription(
                  "Search by character name or UID, then select a suggestion",
                )
                .setDescriptionLocalizations({
                  "zh-TW": "輸入角色名稱或 UID 搜尋，並從下拉清單選取",
                })
                .setAutocomplete(true)
                .setRequired(false),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("view")
            .setNameLocalizations({
              "zh-TW": "查看統計",
            })
            .setDescription("View your gacha statistics")
            .setDescriptionLocalizations({
              "zh-TW": "查看您的抽卡統計數據圖",
            })
            .addUserOption((option) =>
              option
                .setName("user")
                .setNameLocalizations({
                  "zh-TW": "使用者",
                })
                .setDescription("The user to view stats for")
                .setDescriptionLocalizations({
                  "zh-TW": "要查看其統計數據的使用者",
                })
                .setRequired(false),
            )
            .addStringOption((option) =>
              option
                .setName("account")
                .setNameLocalizations({
                  "zh-TW": "帳號",
                })
                .setDescription("Select the account to view")
                .setDescriptionLocalizations({
                  "zh-TW": "選擇要查看的帳號",
                })
                .setAutocomplete(true)
                .setRequired(false),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("leaderboard")
            .setNameLocalizations({
              "zh-TW": "排行榜",
            })
            .setDescription("View gacha leaderboard")
            .setDescriptionLocalizations({
              "zh-TW": "查看抽卡排行榜",
            }),
        )
        .addSubcommand((sub) =>
          sub
            .setName("clear")
            .setNameLocalizations({
              "zh-TW": "清除紀錄",
            })
            .setDescription("Clear your gacha logs")
            .setDescriptionLocalizations({
              "zh-TW": "清除您的抽卡紀錄",
            })
            .addStringOption((option) =>
              option
                .setName("account")
                .setNameLocalizations({
                  "zh-TW": "帳號",
                })
                .setDescription("Select the account to clear")
                .setDescriptionLocalizations({
                  "zh-TW": "選擇要清除的帳號",
                })
                .setAutocomplete(true)
                .setRequired(false),
            )
            .addStringOption((option) =>
              option
                .setName("start_time")
                .setNameLocalizations({
                  "zh-TW": "開始時間",
                })
                .setDescription("Format: YYYY-MM-DD")
                .setDescriptionLocalizations({
                  "zh-TW": "格式：YYYY-MM-DD",
                })
                .setRequired(false),
            )
            .addStringOption((option) =>
              option
                .setName("end_time")
                .setNameLocalizations({
                  "zh-TW": "結束時間",
                })
                .setDescription("Format: YYYY-MM-DD")
                .setDescriptionLocalizations({
                  "zh-TW": "格式：YYYY-MM-DD",
                })
                .setRequired(false),
            ),
        ),
    );
