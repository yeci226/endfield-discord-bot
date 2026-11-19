import {
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  ButtonInteraction,
} from "discord.js";
import { Command } from "../../interfaces/Command";
import { gachaCommandData } from "../../features/gacha/command/builder";
import { createGachaContext } from "../../features/gacha/command/context";
import {
  handleGachaSelectMenu,
  handleGachaButton,
  handleGachaModal,
} from "../../features/gacha/command/components";
import { handleLogHow, handleLogLoad } from "../../features/gacha/command/load";
import { handleLogClear } from "../../features/gacha/command/maintenance";
import { handleGachaView } from "../../features/gacha/command/view";
import { handleGachaLeaderboard } from "../../features/gacha/command/leaderboard";
import { handleGachaList } from "../../features/gacha/command/list";
import { handleSimulate } from "../../features/gacha/command/simulate";
import { gachaAutocomplete } from "../../features/gacha/command/autocomplete";

const command: Command = {
  data: gachaCommandData,

  execute: async (
    client,
    interaction:
      | ChatInputCommandInteraction
      | ModalSubmitInteraction
      | StringSelectMenuInteraction
      | ButtonInteraction,
    tr,
    db,
  ) => {
    const ctx = createGachaContext(client, interaction, tr, db);
    const { subcommandGroup, subcommand } = ctx;

    if (interaction.isStringSelectMenu()) {
      await handleGachaSelectMenu(ctx, interaction);
      return;
    }

    if (interaction.isButton?.()) {
      await handleGachaButton(ctx, interaction as ButtonInteraction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (subcommandGroup === "log") {
        if (subcommand === "how") return handleLogHow(ctx, interaction);
        if (subcommand === "load") return handleLogLoad(ctx, interaction);
        if (subcommand === "clear") return handleLogClear(ctx, interaction);
        if (subcommand === "view") return handleGachaView(ctx, interaction);
        if (subcommand === "leaderboard")
          return handleGachaLeaderboard(ctx, interaction);
      }
      if (subcommand === "list") return handleGachaList(ctx, interaction);
      if (subcommand === "simulate") return handleSimulate(ctx, interaction);
    }

    if (interaction.isModalSubmit()) {
      await handleGachaModal(ctx, interaction);
      return;
    }
  },

  autocomplete: gachaAutocomplete,
};

export default command;
