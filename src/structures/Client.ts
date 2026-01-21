import { Client, Collection, GatewayIntentBits, Partials } from "discord.js";
import { CustomDatabase } from "../utils/Database";
import { Command } from "../interfaces/Command";
import path from "path";
import dotenv from "dotenv";
import { SkportNewsService } from "../services/SkportNewsService";

dotenv.config();

export class ExtendedClient extends Client {
  public commands: Collection<string, Command> = new Collection();
  public db: CustomDatabase;
  public newsService!: SkportNewsService;

  constructor() {
    super({
      intents: [GatewayIntentBits.Guilds],
      partials: [
        Partials.Channel,
        Partials.GuildMember,
        Partials.Message,
        Partials.User,
      ],
    });

    this.db = new CustomDatabase("json.sqlite");
  }

  public start() {
    if (!process.env.DISCORD_TOKEN) {
      console.error("❌ DISCORD_TOKEN is not set in .env");
      process.exit(1);
    }
    this.login(process.env.DISCORD_TOKEN);
  }
}
