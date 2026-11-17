import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import { CustomDatabase } from "./Database";
import {
  accountFingerprint,
  accountId,
  deleteAccountData,
} from "./accountData";

const message = (content: string) =>
  new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(content),
  );
const flags = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

export async function promptAccountUnbind(
  interaction: ChatInputCommandInteraction,
  db: CustomDatabase,
  account: any,
  tr: any,
) {
  const stored = (await db.get<any[]>(`${interaction.user.id}.accounts`))?.find(
    (item) => accountId(item) === accountId(account),
  );
  if (!stored) {
    await interaction.reply({
      flags,
      components: [message(tr("login_UnbindExpired"))],
    });
    return;
  }
  const suffix = `${interaction.user.id}:${Date.now() + 15 * 60 * 1000}:${accountFingerprint(stored)}`;
  const container = message(
    tr("login_UnbindConfirm")
      .replace("<name>", stored.info.nickname)
      .replace("<id>", accountId(stored)),
  );
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`login:delete:${suffix}`)
        .setLabel(tr("login_UnbindConfirmButton"))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`login:cancel:${suffix}`)
        .setLabel(tr("login_UnbindCancelButton"))
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  await interaction.reply({ flags, components: [container] });
}

export async function handleAccountUnbind(
  interaction: ButtonInteraction,
  db: CustomDatabase,
  tr: any,
) {
  const [command, action, owner, expires, fingerprint, extra] =
    interaction.customId.split(":");
  if (command !== "login" || !["delete", "cancel"].includes(action)) return;
  if (
    owner !== interaction.user.id ||
    extra !== undefined ||
    !/^\d+$/.test(expires || "") ||
    Number(expires) <= Date.now() ||
    !/^[a-f0-9]{32}$/.test(fingerprint || "")
  ) {
    await interaction.reply({
      flags,
      components: [message(tr("login_UnbindExpired"))],
    });
    return;
  }
  await interaction.deferUpdate();
  if (action === "cancel") {
    await interaction.editReply({
      components: [message(tr("login_UnbindCancelled"))],
    });
    return;
  }
  const removed = deleteAccountData(db, owner, fingerprint);
  const content = removed
    ? tr("login_UnbindSuccess")
        .replace("<name>", removed.info.nickname)
        .replace("<id>", accountId(removed))
    : tr("login_UnbindExpired");
  await interaction.editReply({ components: [message(content)] });
}
