import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collapseToWeekly,
  filterPortfolioHistory,
  hasBreakdown,
  type PortfolioSnapshotRow,
} from "../lib/stocks/portfolio-history.ts";

// The Stocks "value over time" chart reads the daily net-worth snapshot rows,
// scoped to the INVESTMENT ACCOUNT ONLY (stocks vs. cash-equivalent within
// it — never the manual bank/checking/savings accounts_total, which stays on
// the Net Worth page's own blended chart). This pure filter windows + sorts
// per range. NOW is pinned so day-boundary cases are deterministic.
const NOW = new Date("2026-07-17T18:00:00Z");

function row(
  date: string,
  stocks: number | null,
  cashEquivalent: number | null,
  total: number
): PortfolioSnapshotRow {
  return { date, stocks_value: stocks, cash_equivalent_value: cashEquivalent, total };
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

test("pre-migration rows keep null stocks/cash-equivalent — never fabricated as $0", () => {
  const rows = [
    row("2026-07-10", null, null, 5000), // old row: only the investment-account total exists
    row("2026-07-16", 4200, 900, 5100),
  ];
  const out = filterPortfolioHistory(rows, "1m", NOW);
  assert.equal(out[0].stocks_value, null);
  assert.equal(out[0].cash_equivalent_value, null);
  assert.equal(out[0].total, 5000); // total is still real
  assert.equal(out[1].stocks_value, 4200);
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

  // A single-sided split (only cash-equivalent recorded) still counts as
  // "has breakdown".
  assert.equal(hasBreakdown([row("2026-07-16", null, 900, 900)]), true);
});

// ISO week boundaries used below (verified against the real isoWeekKey
// algorithm): W27 = Jun29–Jul5, W28 = Jul6–Jul12, W29 = Jul13–Jul19,
// W30 = Jul20–Jul26 (2026). Dec28–Jan3 all fall in 2026-W53, crossing the
// calendar-year boundary correctly.

test("collapseToWeekly: a range spanning exactly N full weeks yields one point per week, each the week's LAST day", () => {
  const rows = [
    row("2026-06-29", 1, 1, 2), // W27
    row("2026-07-05", 2, 2, 4), // W27 (last day)
    row("2026-07-06", 3, 3, 6), // W28
    row("2026-07-12", 4, 4, 8), // W28 (last day)
    row("2026-07-13", 5, 5, 10), // W29
    row("2026-07-19", 6, 6, 12), // W29 (last day)
  ];
  const out = collapseToWeekly(rows);
  assert.deepEqual(
    out.map((r) => r.date),
    ["2026-07-05", "2026-07-12", "2026-07-19"]
  );
  // Each point carries the LAST day's values, not an average.
  assert.equal(out[0].total, 4);
  assert.equal(out[1].total, 8);
  assert.equal(out[2].total, 12);
});

test("collapseToWeekly: a partial trailing week still gets a point from whatever's available so far", () => {
  const rows = [
    row("2026-07-13", 1, 1, 2), // W29 starts
    row("2026-07-14", 2, 2, 4),
    row("2026-07-17", 3, 3, 6), // "today" — W29 not yet complete (through Jul 19)
  ];
  const out = collapseToWeekly(rows);
  assert.deepEqual(
    out.map((r) => r.date),
    ["2026-07-17"]
  );
  assert.equal(out[0].total, 6);
});

test("collapseToWeekly: a gap inside a week still resolves to the last available day, not an error", () => {
  const rows = [
    row("2026-07-06", 1, 1, 2), // W28 starts
    row("2026-07-07", 2, 2, 4),
    // Jul 8–11 missing (gap)
    row("2026-07-12", 3, 3, 6), // W28's last available day
  ];
  const out = collapseToWeekly(rows);
  assert.deepEqual(
    out.map((r) => r.date),
    ["2026-07-12"]
  );
});

test("collapseToWeekly: crosses a calendar-year boundary within one ISO week correctly", () => {
  const rows = [
    row("2026-12-28", 1, 1, 2), // 2026-W53
    row("2026-12-31", 2, 2, 4), // 2026-W53
    row("2027-01-02", 3, 3, 6), // still 2026-W53 (year rolled, week didn't)
  ];
  const out = collapseToWeekly(rows);
  assert.deepEqual(
    out.map((r) => r.date),
    ["2027-01-02"]
  );
});

test("collapseToWeekly: empty input is an empty series, never a crash", () => {
  assert.deepEqual(collapseToWeekly([]), []);
});

test("filterPortfolioHistory: granularity defaults to daily (unchanged behavior)", () => {
  const rows = [row("2026-07-10", 1, 1, 2), row("2026-07-12", 2, 2, 4)];
  assert.deepEqual(filterPortfolioHistory(rows, "1m", NOW), rows);
});

test("filterPortfolioHistory: granularity='weekly' collapses the already-range-filtered rows", () => {
  const rows = [
    row("2026-07-13", 1, 1, 2), // W29
    row("2026-07-15", 2, 2, 4), // W29
    row("2026-07-06", 3, 3, 6), // W28 — outside 1m range from NOW (2026-07-17), should be filtered before collapsing
  ];
  const out = filterPortfolioHistory(rows, "1m", NOW, "weekly");
  // Both W28 and W29 survive the 1m window here (cutoff is 2026-06-17), so
  // collapsing should still merge same-week rows: W28's single row stays,
  // W29's two rows collapse to the later one (Jul 15).
  assert.deepEqual(
    out.map((r) => r.date),
    ["2026-07-06", "2026-07-15"]
  );
});
