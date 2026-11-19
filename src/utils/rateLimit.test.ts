import assert from "node:assert/strict";
import { createRateLimiter } from "./rateLimit";

const lim = createRateLimiter({ limit: 3, windowMs: 1000, maxKeys: 4 });

// allows up to the limit, then blocks and reports when to retry
assert.equal(lim.check("u", 0).allowed, true);
assert.equal(lim.check("u", 100).allowed, true);
assert.equal(lim.check("u", 200).allowed, true);
const blocked = lim.check("u", 300);
assert.equal(blocked.allowed, false);
assert.equal(blocked.retryAfterMs, 700);

// rejected attempts are not recorded: released exactly one window after the first allowed hit
assert.equal(lim.check("u", 900).allowed, false);
assert.equal(lim.check("u", 1000).allowed, true); // the hit at t=0 left the window
assert.equal(lim.check("u", 1050).allowed, false); // t=100,200,1000 still inside

// keys are independent
assert.equal(lim.check("other", 1050).allowed, true);

// idle keys are evicted, size never exceeds maxKeys
const small = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3 });
for (let i = 0; i < 3; i++) small.check("k" + i, 0);
assert.equal(small.size(), 3);
small.check("new", 5000); // k0..k2 are idle by now
assert.equal(small.size(), 1);
for (let i = 0; i < 50; i++) small.check("burst" + i, 5000 + i);
assert.ok(small.size() <= 3, "active keys beyond maxKeys evict the oldest");
// an evicted user starts fresh rather than being stuck
assert.equal(small.check("burst0", 5100).allowed, true);

console.log("rateLimit tests passed");
