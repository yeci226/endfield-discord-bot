import assert from "node:assert/strict";
import { isDuplicateClaim } from "./attendanceUtils";

// Shape returned by makeRequest for the production response (HTTP 403 + message).
assert.equal(
  isDuplicateClaim({ code: -1, status: 403, isBlocked: true, message: "請勿重複簽到！" }),
  true,
);
assert.equal(isDuplicateClaim({ code: 10001 }), true);
assert.equal(isDuplicateClaim({ status: 403, message: "请勿重复签到" }), true);
// A real block must stay an error.
assert.equal(
  isDuplicateClaim({ code: -1, status: 403, message: "Identity blocked or WAF triggered." }),
  false,
);
assert.equal(isDuplicateClaim({ code: 0 }), false);
assert.equal(isDuplicateClaim({ code: 10000, status: 401, message: "請求異常" }), false);
assert.equal(isDuplicateClaim(null), false);
// The message alone, without the 403, is not enough.
assert.equal(isDuplicateClaim({ status: 500, message: "請勿重複簽到！" }), false);
