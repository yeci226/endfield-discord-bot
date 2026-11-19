import crypto from "crypto";

export const COMMANDS_HASH_KEY = "commands_hash";

/** JSON with object keys sorted at every level; array order is preserved (option order matters). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] === undefined || typeof obj[key] === "function") continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(obj[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  const out = JSON.stringify(value);
  return out === undefined ? "null" : out;
}

/** SHA-256 over the command definitions sorted by name; independent of load order and key order. */
export function computeCommandsHash(commandsJson: unknown[]): string {
  const sorted = [...commandsJson].sort((a: any, b: any) => {
    const x = String(a?.name ?? "");
    const y = String(b?.name ?? "");
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return crypto.createHash("sha256").update(stableStringify(sorted)).digest("hex");
}

export interface CommandRegistryDb {
  get<T = any>(key: string): Promise<T | null>;
  set(key: string, value: any): Promise<void>;
}

export type RegisterResult = "registered" | "unchanged" | "failed";

/**
 * Registers the commands only when their definition hash differs from the one
 * stored after the last successful registration. The hash is written only
 * after `put` resolves, so a failed registration is retried on the next start.
 */
export async function registerCommandsIfChanged(opts: {
  db: CommandRegistryDb;
  commandsJson: unknown[];
  put: (body: unknown[]) => Promise<unknown>;
  log?: { info(msg: string): void; error(msg: string): void };
}): Promise<RegisterResult> {
  const hash = computeCommandsHash(opts.commandsJson);
  const stored = await opts.db.get<string>(COMMANDS_HASH_KEY);
  if (stored === hash) {
    opts.log?.info("Application commands unchanged; skipping registration.");
    return "unchanged";
  }
  try {
    await opts.put(opts.commandsJson);
  } catch (error: any) {
    opts.log?.error(`Command registration failed: ${error?.message || error}`);
    return "failed";
  }
  await opts.db.set(COMMANDS_HASH_KEY, hash);
  opts.log?.info("Application commands registered.");
  return "registered";
}
