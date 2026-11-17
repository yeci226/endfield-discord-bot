import { Events } from "discord.js";
import type { Event } from "../interfaces/Event";
import { handleContactDevInteraction } from "../utils/contactDev";

const event: Event = {
  name: Events.InteractionCreate,
  execute: async (_client, interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    if (!interaction.customId?.startsWith("contact-dev:")) return;
    await handleContactDevInteraction(interaction);
  },
};

export default event;
