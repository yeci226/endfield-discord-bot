import { ClientEvents } from "discord.js";
import { ExtendedClient } from "../structures/Client";

export interface Event {
  name: keyof ClientEvents;
  once?: boolean;
  execute: (client: ExtendedClient, ...args: any[]) => Promise<any> | any;
}
