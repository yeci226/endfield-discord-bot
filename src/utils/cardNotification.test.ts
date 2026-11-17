import assert from "node:assert/strict";
import { AttachmentBuilder, MessageFlags } from "discord.js";
import { buildCardMessages } from "./cardNotification";

const files = Array.from(
  { length: 19 },
  (_, i) =>
    new AttachmentBuilder(Buffer.from("image"), { name: `daily-${i}.png` }),
);
const messages = buildCardMessages(
  [
    { label: "Account 1", files: files.slice(0, 2) },
    { label: "Account 2", files: files.slice(2) },
  ],
  "<@99>",
  true,
);
assert.deepEqual(
  messages.map((message) => message.files.length),
  files.map(() => 1),
  "Plain images must be sent separately to prevent Discord's tiled thumbnails",
);
assert.deepEqual(
  messages.flatMap((message) => message.files),
  files,
);
for (const message of messages) {
  assert.equal(message.content, "<@99>");
  assert.equal(message.flags, undefined);
  assert.equal(message.components, undefined);
}
assert.equal(
  buildCardMessages([{ files }], undefined, true)[0].content,
  undefined,
);
const componentsMessages = buildCardMessages([{ files }]);
assert.equal(componentsMessages[0].flags, MessageFlags.IsComponentsV2);
assert.deepEqual(
  componentsMessages.map((message) => message.files.length),
  [8, 8, 3],
);
console.log("cardNotification checks passed");
