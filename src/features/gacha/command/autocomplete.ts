import {
  User,
  AutocompleteInteraction,
} from "discord.js";
import {
  getAccounts,
} from "../../../utils/accountUtils";
import {
  loadSimPoolRecords,
} from "../../../utils/gachaSimulatorUtils";
import { createTranslator, toI18nLang } from "../../../utils/i18n";
import { CustomDatabase } from "../../../utils/Database";
import { mapPossibleUserRoles } from "./accounts";
import { orderSimPools } from "./simulate";
import { ExtendedClient } from "../../../structures/Client";

export async function gachaAutocomplete(
  client: ExtendedClient,
  interaction: AutocompleteInteraction,
  db: CustomDatabase,
) {
  const tr = createTranslator(toI18nLang(interaction.locale));
  const subcommand = interaction.options.getSubcommand(false);
  const focusedValue = interaction.options.getFocused();

  if (
    subcommand === "view" ||
    subcommand === "clear" ||
    subcommand === "load"
  ) {
    const targetUser =
      (interaction.options.get("user")?.user as User) || interaction.user;
    // Autocomplete must stay local and fast: binding refreshes may call SKPort.
    const cachedAccounts = await getAccounts(db, targetUser.id);
    const allRoles = mapPossibleUserRoles(cachedAccounts);

    // Guest IDs include their owner's Discord ID; use a literal indexed prefix
    // rather than extracting nicknames from every user's full gacha log.
    const gachaLogNicknames = db.findFieldByGlobPrefix(
      `GACHA_LOG_EF_GUEST_${targetUser.id}_`,
      "$.info.nickname",
    );

    const choices: { name: string; value: string }[] = [];

    // Add bound roles, deduplicated by rawUid (prefer uid with existing data)
    const seenAutoRawUids = new Map<string, string>(); // rawUid -> selected uid
    for (const r of allRoles) {
      if (!seenAutoRawUids.has(r.rawUid)) {
        seenAutoRawUids.set(r.rawUid, r.uid);
      } else {
        const existing = seenAutoRawUids.get(r.rawUid)!;
        const existingHasData =
          (await db.get(`GACHA_LOG_${existing}`)) != null;
        if (!existingHasData) {
          const thisHasData = (await db.get(`GACHA_LOG_${r.uid}`)) != null;
          if (thisHasData) seenAutoRawUids.set(r.rawUid, r.uid);
        }
      }
    }
    for (const [rawUid, uid] of seenAutoRawUids) {
      const role = allRoles.find((r) => r.uid === uid)!;
      choices.push({
        name: `${role.nickname} (${rawUid})`,
        value: uid,
      });
    }

    if (subcommand === "load") {
      choices.push({
        name: tr("gacha_log_load_CreateNewGuest"),
        value: "CREATE_NEW_GUEST",
      });
    }

    // Add guest roles or other roles that have data
    const userPrefix = targetUser.id;
    for (const log of gachaLogNicknames) {
      const uid = log.id.replace("GACHA_LOG_", "");
      if (
        (uid.includes(userPrefix) || choices.some((c) => c.value === uid)) &&
        !choices.some((c) => c.value === uid)
      ) {
        let nickname: string = log.field || "";
        if (!nickname || nickname === "Unknown" || nickname === uid) {
          if (uid.startsWith("EF_GUEST_")) {
            const parts = uid.split("_");
            const ts = parts[parts.length - 1];
            nickname =
              ts.length > 8 ? `Guest (${ts.substring(0, 6)}...)` : "Guest";
          } else {
            nickname = "Unknown";
          }
        }
        choices.push({
          name: `${nickname} (${uid})`,
          value: uid,
        });
      }
    }

    const filtered = choices
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(focusedValue.toLowerCase()) ||
          choice.value.toLowerCase().includes(focusedValue.toLowerCase()),
      )
      .slice(0, 25);

    await interaction.respond(filtered);
    return;
  }

  if (subcommand === "simulate") {
    const choices: { name: string; value: string }[] = [];
    const recs = orderSimPools(
      await loadSimPoolRecords(db, interaction.user.id),
    );
    for (const r of recs) {
      if (!choices.some((c) => c.value === r.poolId)) {
        choices.push({ name: r.poolName || r.poolId, value: r.poolId });
      }
    }

    await interaction.respond(
      choices
        .filter(
          (c) =>
            c.name.toLowerCase().includes(focusedValue.toLowerCase()) ||
            c.value.toLowerCase().includes(focusedValue.toLowerCase()),
        )
        .slice(0, 25),
    );
    return;
  }
}
