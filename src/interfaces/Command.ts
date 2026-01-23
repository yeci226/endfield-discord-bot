import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandOptionsOnlyBuilder,
  AutocompleteInteraction,
  Message,
  ModalSubmitInteraction,
} from "discord.js";
import { CustomDatabase } from "../utils/Database";
import { ExtendedClient } from "../structures/Client";

export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | SlashCommandOptionsOnlyBuilder;
  execute: (
    client: ExtendedClient,
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    tr: any, // Translation function placeholder
    db: CustomDatabase,
  ) => Promise<any>;
  autocomplete?: (
    client: ExtendedClient,
    interaction: AutocompleteInteraction,
    db: CustomDatabase,
  ) => Promise<any>;
}
