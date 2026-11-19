import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

process.env.ENCRYPTION_KEY = "k".repeat(40);

import {
  decrypt,
  decryptAccount,
  encrypt,
  encryptAccount,
  maskSecret,
  validateEncryptionKey,
} from "./cryptoUtils";

// round trip + random IV
const a = encrypt("hello secret");
const b = encrypt("hello secret");
assert.notEqual(a, "hello secret");
assert.notEqual(a, b);
assert.equal(decrypt(a), "hello secret");
assert.equal(encrypt(""), "");

// legacy plaintext passes through untouched (also with colons)
for (const legacy of ["plain-cookie", "a:b", "a:b:c", "x=1; y=2:3:4", ""]) {
  assert.equal(decrypt(legacy), legacy);
}

// tampered ciphertext must throw, not return garbage
{
  const [iv, tag, data] = a.split(":");
  const flipped = (data[0] === "0" ? "1" : "0") + data.slice(1);
  assert.throws(() => decrypt(`${iv}:${tag}:${flipped}`));
  const badTag = (tag[0] === "0" ? "1" : "0") + tag.slice(1);
  assert.throws(() => decrypt(`${iv}:${badTag}:${data}`));
}

// wrong key must throw
{
  const saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "z".repeat(40);
  assert.throws(() => decrypt(a));
  process.env.ENCRYPTION_KEY = saved;
  assert.equal(decrypt(a), "hello secret");
}

// encrypt throws when the key is unusable (never returns plaintext)
{
  const saved = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  assert.throws(() => encrypt("x"));
  process.env.ENCRYPTION_KEY = "short";
  assert.throws(() => encrypt("x"));
  process.env.ENCRYPTION_KEY = saved;
}

// account helpers
{
  const acc = encryptAccount({ cred: "c", salt: "s", cookie: "k", other: 1 });
  assert.notEqual(acc.cred, "c");
  assert.deepEqual(decryptAccount(acc), {
    cred: "c",
    salt: "s",
    cookie: "k",
    other: 1,
  });
  // mixed legacy account
  assert.deepEqual(decryptAccount({ cred: "plain" }), { cred: "plain" });
}

// maskSecret
assert.equal(maskSecret("abcdefghijkl"), "abcd…ijkl");
assert.equal(maskSecret("12345678"), "****");
assert.equal(maskSecret("abc"), "****");
assert.equal(maskSecret(""), "****");
assert.equal(maskSecret("123456789"), "1234…6789");

// key validation
assert.ok(validateEncryptionKey(undefined));
assert.ok(validateEncryptionKey(""));
assert.ok(validateEncryptionKey("short"));
assert.equal(validateEncryptionKey("a".repeat(64)), null);
assert.ok(validateEncryptionKey("x".repeat(15)));
assert.equal(validateEncryptionKey("x".repeat(16)), null);

// module load: production without a usable key refuses to start
{
  const file = path.join(__dirname, "cryptoUtils.ts");
  const run = (key: string | undefined, nodeEnv: string) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: nodeEnv,
      TS_NODE_TRANSPILE_ONLY: "1",
      DOTENV_CONFIG_QUIET: "true",
    };
    if (key === undefined) delete env.ENCRYPTION_KEY;
    else env.ENCRYPTION_KEY = key;
    return spawnSync(process.execPath, ["-r", "ts-node/register", file], {
      env,
      cwd: path.join(__dirname, "..", ".."),
      encoding: "utf8",
    });
  };
  assert.notEqual(run(undefined, "production").status, 0);
  assert.notEqual(run("short", "production").status, 0);
  assert.equal(run("p".repeat(64), "production").status, 0);
  assert.equal(run(undefined, "development").status, 0);
}

console.log("cryptoUtils tests passed");
