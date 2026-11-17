import { CustomDatabase } from "../src/utils/Database";
import { updateLeaderboard } from "../src/utils/gachaLogUtils";
import { decryptAccount } from "../src/utils/cryptoUtils";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const dbPath = path.join(process.cwd(), "json.sqlite");
  const db = new CustomDatabase(dbPath);
  const buffer = fs.readFileSync(dbPath);

  console.log("--- Production Gacha Log Salvage Tool ---");

  // 1. Build UID -> Discord User mapping
  console.log("Mapping UIDs to Discord Users...");
  const uidToDiscord = new Map<string, { userId: string; nick: string }>();
  const allEntries = await db.all();
  for (const entry of allEntries) {
    if (entry.id.endsWith(".accounts")) {
      const userId = entry.id.replace(".accounts", "");
      try {
        const accounts = entry.value.map((a: any) => decryptAccount(a));
        for (const acc of accounts) {
          if (acc.roles) {
            for (const binding of acc.roles) {
              const nick = binding.nickName || binding.nickname || "User";
              uidToDiscord.set(binding.uid, { userId, nick });
              if (binding.roles) {
                for (const role of binding.roles) {
                  uidToDiscord.set(role.roleId || role.uid, {
                    userId,
                    nick: role.nickname || nick,
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        // Skip failed decryptions
      }
    }
  }
  console.log(`Mapped ${uidToDiscord.size} UIDs.`);

  // 2. Harvest all gacha records from binary
  console.log(
    "Harvesting records from database binary (this may take a minute)...",
  );
  const searchBuffer = Buffer.from('"seqId":');
  const recordsByUid = new Map<string, Set<string>>();
  let pos = 0;

  while (true) {
    pos = buffer.indexOf(searchBuffer, pos);
    if (pos === -1) break;

    let start = pos;
    while (start > pos - 500 && start > 0 && buffer[start] !== 123) start--;

    if (buffer[start] === 123) {
      let end = start;
      let bCount = 0;
      let hasStarted = false;
      for (let i = start; i < buffer.length && i < start + 2000; i++) {
        if (buffer[i] === 123) {
          bCount++;
          hasStarted = true;
        } else if (buffer[i] === 125) bCount--;
        if (hasStarted && bCount === 0) {
          end = i;
          break;
        }
      }

      if (bCount === 0 && end > start) {
        const jsonStr = buffer.slice(start, end + 1).toString("utf8");
        try {
          const record = JSON.parse(jsonStr);

          // Trace back to nearest UID context
          let uidSearch = start;
          let uid = "unknown";
          while (uidSearch > start - 20000 && uidSearch > 0) {
            if (
              buffer.slice(uidSearch, uidSearch + 7).toString("utf8") ===
              '"uid":"'
            ) {
              let uidEnd = uidSearch + 7;
              while (uidEnd < buffer.length && buffer[uidEnd] !== 34) uidEnd++;
              uid = buffer.slice(uidSearch + 7, uidEnd).toString("utf8");
              break;
            }
            uidSearch--;
          }

          if (uid !== "unknown" && uid.length < 32) {
            if (!recordsByUid.has(uid)) recordsByUid.set(uid, new Set());
            recordsByUid.get(uid)!.add(jsonStr);
          }
        } catch (e) {}
      }
    }
    pos += searchBuffer.length;
  }
  console.log(`Harvested records for ${recordsByUid.size} UIDs.`);

  // 3. Restore and Sync
  let restoredCount = 0;
  for (const [uid, recordSet] of recordsByUid) {
    const key = `GACHA_LOG_${uid}`;
    const charList = [];
    const weaponList = [];

    for (const rStr of recordSet) {
      const r = JSON.parse(rStr);
      if (r.charId) charList.push(r);
      else if (r.weaponId) weaponList.push(r);
    }

    if (charList.length === 0 && weaponList.length === 0) continue;

    charList.sort((a, b) => Number(b.seqId) - Number(a.seqId));
    weaponList.sort((a, b) => Number(b.seqId) - Number(a.seqId));

    const existing = await db.get<any>(key);
    const existingCount =
      (existing?.characterList?.length || 0) +
      (existing?.weaponList?.length || 0);
    const newCount = charList.length + weaponList.length;

    if (newCount > existingCount) {
      const recoveredData = {
        characterList: charList,
        weaponList: weaponList,
        info: {
          uid: uid,
          lang: existing?.info?.lang || "zh-tw",
          export_timestamp: Date.now(),
          nickname:
            existing?.info?.nickname ||
            uidToDiscord.get(uid)?.nick ||
            "Recovered",
        },
      };

      console.log(
        `Restoring ${key}: ${newCount} records (previously ${existingCount})`,
      );
      await db.set(key, recoveredData);
      restoredCount++;

      // Update leaderboard if we have a mapping
      const mapping = uidToDiscord.get(uid);
      if (mapping) {
        try {
          await updateLeaderboard(
            db,
            uid,
            recoveredData,
            mapping.nick,
            0,
            mapping.nick,
          );
          console.log(
            `  Synced leaderboard for user ${mapping.userId} (${mapping.nick})`,
          );
        } catch (e) {
          console.error(`  Failed to sync leaderboard for ${uid}:`, e);
        }
      }
    }
  }

  console.log(`\nSalvage complete. Restored/Updated ${restoredCount} logs.`);
  console.log("You can now safely restart the bot.");
}

main().catch(console.error);
