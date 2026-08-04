import assert from "node:assert/strict";
import { test } from "node:test";
import {
  comparisonPeriod,
  latestPeriod,
  monthLabel,
  previousMonth,
} from "../lib/finance/period.ts";

// The period baseline comes from the DATA, not the clock: these pure helpers
// operate on the list of YYYY-MM months that actually have transactions.

test("latestPeriod picks the most recent month (lexical == chronological)", () => {
  assert.equal(latestPeriod(["2026-04", "2026-06", "2026-05"]), "2026-06");
  assert.equal(latestPeriod(["2025-12", "2026-01"]), "2026-01");
  assert.equal(latestPeriod([]), null);
});

test("previousMonth rolls the year over correctly", () => {
  assert.equal(previousMonth("2026-06"), "2026-05");
  assert.equal(previousMonth("2026-01"), "2025-12");
  assert.equal(previousMonth("2026-10"), "2026-09");
});

test("comparisonPeriod is the adjacent prior month ONLY when it has data", () => {
  // Adjacent prior month present → return it.
  assert.equal(comparisonPeriod(["2026-05", "2026-06"]), "2026-05");
  // Latest month's prior month is missing (a gap) → null, so the UI says
  // "not enough history" instead of comparing June to a non-adjacent April.
  assert.equal(comparisonPeriod(["2026-04", "2026-06"]), null);
  // Only one month of data → nothing to compare against.
  assert.equal(comparisonPeriod(["2026-06"]), null);
  assert.equal(comparisonPeriod([]), null);
});

test("monthLabel renders a plain-language month", () => {
  assert.equal(monthLabel("2026-06"), "June 2026");
  assert.equal(monthLabel("2025-12"), "December 2025");
});
