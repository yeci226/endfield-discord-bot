import {
  AttachmentBuilder,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import type { ExtendedClient } from "../structures/Client";

/** Kept as a Promise chain: ES6 async helpers are not available after broadcastEval serialization. */
export function sendCardOnOwningCluster(c: any, ctx: any): Promise<any> {
  const guild = ctx.guildId ? c.guilds.cache.get(ctx.guildId) : undefined;
  const cached = c.channels.cache.get(ctx.channelId);
  if ((ctx.guildId && !guild) || (!cached && !guild))
    return Promise.resolve({ owner: false });
  return Promise.resolve(cached || c.channels.fetch(ctx.channelId))
    .then((channel: any) => {
      if (!channel?.send)
        throw Object.assign(new Error("Unknown channel"), { code: 10003 });
      const permissionCheck = guild
        ? guild.members.fetch(ctx.userId).then((member: any) => {
            const { PermissionFlagsBits } = require("discord.js");
            const send = channel.isThread?.()
              ? PermissionFlagsBits.SendMessagesInThreads
              : PermissionFlagsBits.SendMessages;
            if (
              !channel
                .permissionsFor(member)
                ?.has([PermissionFlagsBits.ViewChannel, send]) ||
              !channel
                .permissionsFor(guild.members.me)
                ?.has([
                  PermissionFlagsBits.ViewChannel,
                  send,
                  PermissionFlagsBits.AttachFiles,
                ])
            ) {
              throw Object.assign(new Error("Missing channel permissions"), {
                code: 50013,
              });
            }
          })
        : Promise.resolve();
      return permissionCheck
        .then(() =>
          channel.send({
            ...ctx.payload,
            files: ctx.payload.files.map((f: any) => ({
              attachment: Buffer.from(f.data, "base64"),
              name: f.name,
              description: f.description,
            })),
          }),
        )
        .then(() => ({ owner: true, delivered: true }));
    })
    .catch((error: any) => ({
      owner: true,
      error: error.message,
      code: error.code,
    }));
}

export interface CardGroup {
  label?: string;
  files: AttachmentBuilder[];
}

/** Plain images stay separate; eight galleries leave room for V2 headings. */
export function buildCardMessages(
  groups: CardGroup[],
  text?: string,
  plain = false,
): any[] {
  const cards = groups.flatMap((group) =>
    group.files.map((file) => ({ file, label: group.label })),
  );
  const messages: any[] = [];
  if (!cards.length && text) return [{ content: text }];
  for (let offset = 0; offset < cards.length;) {
    const chunk: typeof cards = [];
    let bytes = 0;
    while (offset < cards.length && chunk.length < (plain ? 1 : 8)) {
      const card = cards[offset];
      const size =
        card.file.attachment instanceof Uint8Array
          ? card.file.attachment.byteLength
          : 0;
      if (chunk.length && bytes + size > 20 * 1024 * 1024) break;
      chunk.push(card);
      bytes += size;
      offset++;
    }
    if (plain) {
      messages.push({
        content: text,
        files: chunk.map((c) => c.file),
        allowedMentions: { parse: [] },
      });
      continue;
    }
    const container = new ContainerBuilder();
    if (text)
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(text),
      );
    let previous: string | undefined;
    for (const { file, label } of chunk) {
      if (label && label !== previous)
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**${label}**`),
        );
      previous = label;
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`),
        ),
      );
    }
    messages.push({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      files: chunk.map((c) => c.file),
      allowedMentions: { parse: [] },
    });
  }
  return messages;
}

export interface NotificationDestination {
  notify_method: "dm" | "channel";
  channelId?: string;
  guildId?: string;
}

/** Throws on failure so reminder callers never mark an undelivered message as sent. */
export async function deliverCardMessage(
  client: ExtendedClient,
  userId: string,
  destination: NotificationDestination,
  payload: any,
): Promise<void> {
  payload = { ...payload, allowedMentions: { parse: [], users: [userId] } };
  if (destination.notify_method === "dm") {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return;
  }
  if (!destination.channelId)
    throw Object.assign(new Error("Missing channel"), { code: 10003 });
  const files = (payload.files || []).map((file: AttachmentBuilder) => {
    if (
      !Buffer.isBuffer(file.attachment) &&
      !(file.attachment instanceof Uint8Array)
    )
      throw new Error("Expected rendered image bytes");
    return {
      name: file.name,
      description: file.description,
      data: Buffer.from(file.attachment).toString("base64"),
    };
  });
  const context = {
    userId,
    channelId: destination.channelId,
    guildId: destination.guildId,
    payload: {
      ...payload,
      components: payload.components?.map((c: any) => c.toJSON?.() ?? c),
      files,
    },
  };
  const local = await sendCardOnOwningCluster(client, context);
  const results = local.owner
    ? [local]
    : await client.cluster.broadcastEval(sendCardOnOwningCluster, { context });
  const result = results.find((r: any) => r?.owner) as any;
  if (!result?.delivered)
    throw Object.assign(
      new Error(result?.error || "Notification guild unavailable"),
      { code: result ? result.code : destination.guildId ? 10004 : 10003 },
    );
}
