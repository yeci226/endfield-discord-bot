import assert from "node:assert/strict";
import {
  BoundedCache,
  createRateLimiter,
  generateToken,
  isPlausibleToken,
  maskTokensInUrl,
  parseAllowedOrigins,
  resolveClientIp,
} from "./webSecurity";

// tokens
{
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(isPlausibleToken(a));
  assert.ok(!isPlausibleToken("short"));
  assert.ok(!isPlausibleToken("../../etc/passwd/aaaaaaaaaaaa"));
  assert.ok(!isPlausibleToken(undefined));
}

// log masking
assert.equal(
  maskTokensInUrl("/api/profile/abcDEF123_-xyz?x=1"),
  "/api/profile/:token?x=1",
);
assert.equal(
  maskTokensInUrl("/endfield/api/preview/abcDEF123_-xyz"),
  "/endfield/api/preview/:token",
);
assert.equal(
  maskTokensInUrl("/profile/edit?token=SECRET&a=b"),
  "/profile/edit?token=:token&a=b",
);
assert.equal(
  maskTokensInUrl("/verify?captchaId=1&session=SECRET&x=2"),
  "/verify?captchaId=1&session=:token&x=2",
);
assert.equal(maskTokensInUrl("/api/proxy?url=a"), "/api/proxy?url=a");

// rate limiter
{
  const rl = createRateLimiter({ limit: 3, windowMs: 1000 });
  assert.ok(rl.check("a", 0).allowed);
  assert.ok(rl.check("a", 100).allowed);
  assert.ok(rl.check("a", 200).allowed);
  const blocked = rl.check("a", 300);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 700);
  assert.ok(rl.check("b", 300).allowed); // separate key
  assert.ok(rl.check("a", 1001).allowed); // first hit left the window
  assert.equal(rl.check("a", 1003).allowed, false);
  // blocked hits do not extend the block
  assert.ok(rl.check("a", 2300).allowed);
}
// key bound
{
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3 });
  for (let i = 0; i < 50; i++) rl.check("k" + i, 0);
  assert.ok(rl.check("fresh", 5000).allowed);
}

// client ip
assert.equal(resolveClientIp("1.2.3.4", "9.9.9.9"), "1.2.3.4"); // spoof ignored
assert.equal(resolveClientIp("127.0.0.1", "9.9.9.9, 10.0.0.1"), "9.9.9.9");
assert.equal(resolveClientIp("::1", ["8.8.8.8"]), "8.8.8.8");
assert.equal(resolveClientIp("::ffff:127.0.0.1", undefined), "::ffff:127.0.0.1");
assert.equal(resolveClientIp(undefined, undefined), "unknown");

// origins
assert.deepEqual(parseAllowedOrigins(undefined), []);
assert.deepEqual(parseAllowedOrigins(""), []);
assert.deepEqual(parseAllowedOrigins("https://a.com/, https://b.com ,"), [
  "https://a.com",
  "https://b.com",
]);

// bounded cache
{
  const c = new BoundedCache<number>(3);
  c.set("a", 1, 1000, 10_000, 0);
  c.set("b", 2, 1000, 10_000, 0);
  c.set("c", 3, 1000, 10_000, 0);
  c.set("d", 4, 1000, 10_000, 0); // evicts oldest
  assert.equal(c.size, 3);
  assert.equal(c.get("a", 1), undefined);
  assert.equal(c.get("d", 1), 4);
  // ttl expiry
  assert.equal(c.get("d", 1001), undefined);
  // token expiry evicts even while ttl is valid
  c.set("t", 9, 100_000, 500, 0);
  assert.equal(c.get("t", 400), 9);
  assert.equal(c.get("t", 501), undefined);
  // prune drops expired before evicting live entries
  const d = new BoundedCache<number>(2);
  d.set("x", 1, 10, 10_000, 0);
  d.set("y", 2, 10_000, 10_000, 0);
  d.set("z", 3, 10_000, 10_000, 100); // x expired -> pruned, y survives
  assert.equal(d.get("y", 100), 2);
  assert.equal(d.get("z", 100), 3);
}

console.log("webSecurity tests passed");
