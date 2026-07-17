import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterPortfolioHistory,
  hasBreakdown,
  type PortfolioSnapshotRow,
} from "../lib/stocks/portfolio-history.ts";

// The Stocks "value over time" chart reads the daily net-worth snapshot rows
// (holdings/cash split + blended total) and this pure filter windows + sorts
// them per range. NOW is pinned so day-boundary cases are deterministic.
const NOW = new Date("2026-07-17T18:00:00Z");

function row(
  date: string,
  holdings: number | null,
  cash: number | null,
  total: number
): PortfolioSnapshotRow {
  return { date, holdings_value: holdings, cash_value: cash, total };
}

test("empty input returns an empty series for every range", () => {
  assert.deepEqual(filterPortfolioHistory([], "3m", NOW), []);
  assert.deepEqual(filterPortfolioHistory([], "all", NOW), []);
});

test("a single in-window row is returned as-is", () => {
  const rows = [row("2026-07-10", 4200, 800, 5000)];
  assert.deepEqual(filterPortfolioHistory(rows, "1m", NOW), rows);
});

test("a single out-of-window row is filtered out", () => {
  const rows = [row("2026-01-01", 4200, 800, 5000)]; // >6 months before NOW
  assert.deepEqual(filterPortfolioHistory(rows, "3m", NOW), []);
  // …but 'all' keeps it.
  assert.deepEqual(filterPortfolioHistory(rows, "all", NOW), rows);
});

test("range boundary is inclusive: the row exactly `days` ago is kept, the day before is dropped", () => {
  // 1m = 30 days. Cutoff from 2026-07-17 is 2026-06-17.
  const rows = [
    row("2026-06-16", 1, 1, 2), // one day before cutoff → dropped
    row("2026-06-17", 3, 3, 6), // exactly cutoff → kept
    row("2026-07-17", 5, 5, 10), // today → kept
  ];
  const out = filterPortfolioHistory(rows, "1m", NOW);
  assert.deepEqual(
    out.map((r) => r.date),
    ["2026-06-17", "2026-07-17"]
  );
});

test("output is sorted oldest-first regardless of input order", () => {
  const rows = [
    row("2026-07-15", 3, 3, 6),
    row("2026-07-10", 1, 1, 2),
    row("2026-07-12", 2, 2, 4),
  ];
  const out = filterPortfolioHistory(rows, "1m", NOW);
  assert.deepEqual(
    out.map((r) => r.date),
    ["2026-07-10", "2026-07-12", "2026-07-15"]
  );
});

test("pre-migration rows keep null holdings/cash — never fabricated as $0", () => {
  const rows = [
    row("2026-07-10", null, null, 5000), // old row: only the blended total exists
    row("2026-07-16", 4200, 900, 5100),
  ];
  const out = filterPortfolioHistory(rows, "1m", NOW);
  assert.equal(out[0].holdings_value, null);
  assert.equal(out[0].cash_value, null);
  assert.equal(out[0].total, 5000); // total is still real
  assert.equal(out[1].holdings_value, 4200);
});

test("each range window includes the right rows", () => {
  const rows = [
    row("2025-07-16", 1, 1, 2), // ~1y+1day ago
    row("2026-01-16", 2, 2, 4), // ~6m ago (183 days) — outside 6m(180), inside 1y
    row("2026-04-18", 3, 3, 6), // ~90 days ago (inside 3m)
    row("2026-06-20", 4, 4, 8), // inside 1m
  ];
  assert.deepEqual(
    filterPortfolioHistory(rows, "1m", NOW).map((r) => r.date),
    ["2026-06-20"]
  );
  assert.deepEqual(
    filterPortfolioHistory(rows, "3m", NOW).map((r) => r.date),
    ["2026-04-18", "2026-06-20"]
  );
  assert.deepEqual(
    filterPortfolioHistory(rows, "1y", NOW).map((r) => r.date),
    ["2026-01-16", "2026-04-18", "2026-06-20"]
  );
  assert.deepEqual(filterPortfolioHistory(rows, "all", NOW).length, 4);
});

test("hasBreakdown: false when every surviving point is null-split, true when any has a split", () => {
  const onlyTotals = [row("2026-07-10", null, null, 5000), row("2026-07-16", null, null, 5100)];
  assert.equal(hasBreakdown(onlyTotals), false);
  assert.equal(hasBreakdown([]), false);

  const mixed = [row("2026-07-10", null, null, 5000), row("2026-07-16", 4200, 900, 5100)];
  assert.equal(hasBreakdown(mixed), true);

  // A single-sided split (only cash recorded) still counts as "has breakdown".
  assert.equal(hasBreakdown([row("2026-07-16", null, 900, 900)]), true);
});
