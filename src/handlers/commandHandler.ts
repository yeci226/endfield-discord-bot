import { ExtendedClient } from "../structures/Client";
import fs from "fs";
import path from "path";
import { Command } from "../interfaces/Command";
import { Logger } from "../utils/Logger";

const logger = new Logger("CommandHandler");

function isCommandCandidate(file: string): boolean {
  if (file.endsWith(".d.ts")) return false;
  if (file.endsWith(".test.ts") || file.endsWith(".test.js")) return false;
  return file.endsWith(".ts") || file.endsWith(".js");
}

function findCommandFiles(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findCommandFiles(filePath));
    } else if (isCommandCandidate(file)) {
      results.push(filePath);
    }
  });
  return results;
}

export async function loadCommandsFrom(
  client: { commands: { set(name: string, command: Command): unknown } },
  dir: string,
): Promise<{ loaded: string[]; skipped: string[]; failed: string[] }> {
  const loaded: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const file of findCommandFiles(dir)) {
    let command: Command | undefined;
    try {
      let mod = (await import(file)).default as any;
      // plain CommonJS files without __esModule arrive double-wrapped
      if (mod && !mod.data && mod.default) mod = mod.default;
      command = mod as Command | undefined;
    } catch (err) {
      logger.error(`Failed to import command file ${file}`, err);
      failed.push(file);
      continue;
    }
    if (
      !command ||
      typeof command.data?.name !== "string" ||
      typeof command.execute !== "function"
    ) {
      logger.warn(`Skipped ${file}: no default export with data.name and execute`);
      skipped.push(file);
      continue;
    }
    client.commands.set(command.data.name, command);
    loaded.push(command.data.name);
    logger.success(`Loaded command: ${command.data.name}`);
  }
  return { loaded, skipped, failed };
}

export async function loadCommands(client: ExtendedClient) {
  await loadCommandsFrom(client, path.join(__dirname, "../commands"));
}
