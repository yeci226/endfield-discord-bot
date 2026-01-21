import { ExtendedClient } from "../structures/Client";
import fs from "fs";
import path from "path";
import { Command } from "../interfaces/Command";
import { Logger } from "../utils/Logger";

const logger = new Logger("CommandHandler");

function findCommandFiles(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findCommandFiles(filePath));
    } else if (file.endsWith(".ts") || file.endsWith(".js")) {
      results.push(filePath);
    }
  });
  return results;
}

export async function loadCommands(client: ExtendedClient) {
  const commandsPath = path.join(__dirname, "../commands");
  // Recursive find
  const commandFiles = findCommandFiles(commandsPath);

  for (const file of commandFiles) {
    const command = (await import(file)).default as Command;
    client.commands.set(command.data.name, command);
    // commandsData.push(command.data.toJSON()); // commandsData is unused or should be returned?
    // Actually loadCommands is void and pushes to client.commands collection.
    logger.success(`Loaded command: ${command.data.name}`);
  }
}

function getFiles(dir: string): string[] {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  let commandFiles: string[] = [];

  for (const file of files) {
    const res = path.resolve(dir, file.name);
    if (file.isDirectory()) {
      commandFiles = commandFiles.concat(getFiles(res));
    } else {
      if (file.name.endsWith(".ts") || file.name.endsWith(".js")) {
        commandFiles.push(res);
      }
    }
  }
  return commandFiles;
}
