import {
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  ButtonInteraction,
} from "discord.js";
import { CustomDatabase } from "../../../utils/Database";
import { ExtendedClient } from "../../../structures/Client";

export type GachaInteraction =
  | ChatInputCommandInteraction
  | ModalSubmitInteraction
  | StringSelectMenuInteraction
  | ButtonInteraction;

/** What the old execute() closure shared between its nested helpers and branches. */
export interface GachaContext {
  client: ExtendedClient;
  interaction: GachaInteraction;
  tr: any;
  db: CustomDatabase;
  subcommandGroup: string | null;
  subcommand: string | null;
  isZhLocale: boolean;
}

export function createGachaContext(
  client: ExtendedClient,
  interaction: GachaInteraction,
  tr: any,
  db: CustomDatabase,
): GachaContext {
  const subcommandGroup = interaction.isChatInputCommand()
    ? interaction.options.getSubcommandGroup(false)
    : null;
  const subcommand = interaction.isChatInputCommand()
    ? interaction.options.getSubcommand(false)
    : null;

  const isZhLocale = String(tr.lang || interaction.locale || "")
    .toLowerCase()
    .startsWith("zh");
  return {
    client,
    interaction,
    tr,
    db,
    subcommandGroup,
    subcommand,
    isZhLocale,
  };
}
