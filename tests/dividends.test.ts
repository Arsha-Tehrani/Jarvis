import assert from "node:assert/strict";
import { test } from "node:test";
import { dividendPayout } from "../lib/dividends-math.ts";

// Payout = amount/share × shares. When the ex-date share count is known it's
// exact; otherwise it falls back to the current share count and must flag the
// result as approximate rather than presenting an estimate as exact.

test("exact payout when shares on the ex-date are recorded", () => {
  const r = dividendPayout(1.25, 40, 999);
  assert.deepEqual(r, { payout: 50, approximate: false }); // 1.25 × 40, ignores current shares
});

test("approximate payout falls back to current share count and is flagged", () => {
  const r = dividendPayout(0.5, null, 85);
  assert.deepEqual(r, { payout: 42.5, approximate: true });
});

test("rounds to cents", () => {
  assert.equal(dividendPayout(0.333, 10, 10).payout, 3.33);
});
