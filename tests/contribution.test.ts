import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONCENTRATION_THRESHOLD,
  closeOnOrBefore,
  formatContributionAnswer,
  computeContribution,
  type ContributionHoldingInput,
  type HistoricalPrices,
} from "../lib/stocks/contribution.ts";

// "How much of my portfolio's move is one or two stocks?" — the pure engine.
// currentValue is fed in already valued by computePortfolioTotal (quote×shares
// or cost-basis fallback); these cases pin the attribution math + the no-data
// and divide-by-zero guards the spec requires.

function h(ticker: string, shares: number, currentValue: number): ContributionHoldingInput {
  return { ticker, shares, currentValue };
}

test("all holdings up: contributions positive, percentOfTotalChange sums to ~100%", () => {
  const holdings = [h("AAPL", 10, 1200), h("MSFT", 5, 1100)];
  const hist: HistoricalPrices = { AAPL: 100, MSFT: 200 }; // start 1000, 1000
  const r = computeContribution(holdings, hist);
  const aapl = r.holdings.find((x) => x.ticker === "AAPL")!;
  const msft = r.holdings.find((x) => x.ticker === "MSFT")!;
  assert.equal(aapl.dollarContribution, 200); // 1200 - 1000
  assert.equal(msft.dollarContribution, 100); // 1100 - 1000
  assert.equal(r.totalPortfolioDollarChange, 300);
  const pctSum = (aapl.percentOfTotalChange ?? 0) + (msft.percentOfTotalChange ?? 0);
  assert.ok(Math.abs(pctSum - 100) < 1e-9, `pct summed to ${pctSum}`);
  // Sorted by |contribution| desc: AAPL (200) before MSFT (100).
  assert.deepEqual(r.holdings.map((x) => x.ticker), ["AAPL", "MSFT"]);
});

test("all holdings down: contributions negative, percentReturn negative", () => {
  const holdings = [h("AAPL", 10, 800), h("MSFT", 5, 900)];
  const hist: HistoricalPrices = { AAPL: 100, MSFT: 200 }; // start 1000, 1000
  const r = computeContribution(holdings, hist);
  assert.equal(r.holdings.find((x) => x.ticker === "AAPL")!.dollarContribution, -200);
  assert.equal(r.holdings.find((x) => x.ticker === "AAPL")!.percentReturn, -20);
  assert.equal(r.totalPortfolioDollarChange, -300);
});

test("mixed signs: a big loser and a small winner net out", () => {
  const holdings = [h("NVDA", 2, 500), h("TSLA", 4, 900)];
  const hist: HistoricalPrices = { NVDA: 400, TSLA: 200 }; // start 800, 800
  const r = computeContribution(holdings, hist);
  const nvda = r.holdings.find((x) => x.ticker === "NVDA")!;
  const tsla = r.holdings.find((x) => x.ticker === "TSLA")!;
  assert.equal(nvda.dollarContribution, -300); // 500 - 800
  assert.equal(tsla.dollarContribution, 100); // 900 - 800
  assert.equal(r.totalPortfolioDollarChange, -200);
  // Ranked by absolute move: NVDA (300) before TSLA (100).
  assert.deepEqual(
    r.holdings.map((x) => x.ticker),
    ["NVDA", "TSLA"]
  );
  // totalAbsChange (denominator for concentration) is |−300|+|100| = 400.
  assert.equal(r.totalAbsChange, 400);
});

test("a cost-basis-fallback holding (no live quote) mixes with quoted holdings", () => {
  // SPAXX has no live quote, so computePortfolioTotal valued it at cost basis
  // (currentValue = cost_basis × shares = 1 × 300 = 300). It still gets a real
  // contribution against its historical $1 close.
  const holdings = [h("AAPL", 10, 1200), h("SPAXX", 300, 300)];
  const hist: HistoricalPrices = { AAPL: 100, SPAXX: 1 };
  const r = computeContribution(holdings, hist);
  const spaxx = r.holdings.find((x) => x.ticker === "SPAXX")!;
  assert.equal(spaxx.hasData, true);
  assert.equal(spaxx.startValue, 300);
  assert.equal(spaxx.dollarContribution, 0); // 300 - 300, a money-market core doesn't move
  assert.equal(r.holdings.find((x) => x.ticker === "AAPL")!.dollarContribution, 200);
});

test("a holding with no historical price is flagged 'no data', never dropped or zeroed", () => {
  // NEWCO was just bought — no period-start close available.
  const holdings = [h("AAPL", 10, 1200), h("NEWCO", 50, 5000)];
  const hist: HistoricalPrices = { AAPL: 100 }; // NEWCO absent
  const r = computeContribution(holdings, hist);
  const newco = r.holdings.find((x) => x.ticker === "NEWCO")!;
  assert.equal(newco.hasData, false);
  assert.equal(newco.dollarContribution, null); // NOT 0
  assert.equal(newco.startValue, null);
  assert.equal(newco.percentOfTotalChange, null);
  assert.equal(newco.percentReturn, null);
  // It's still present (never dropped) and sorted last, after holdings with data.
  assert.equal(r.holdings.length, 2);
  assert.equal(r.holdings[r.holdings.length - 1].ticker, "NEWCO");
  // The no-data holding contributes nothing to the totals.
  assert.equal(r.totalPortfolioDollarChange, 200);
});

test("an explicit null historical price is also treated as no data", () => {
  const holdings = [h("GAP", 10, 1000)];
  const hist: HistoricalPrices = { GAP: null };
  const r = computeContribution(holdings, hist);
  assert.equal(r.holdings[0].hasData, false);
  assert.equal(r.holdings[0].dollarContribution, null);
});

test("zero total portfolio change: percentOfTotalChange is null (not Infinity/NaN)", () => {
  // Two holdings that exactly offset: +100 and −100 → net 0.
  const holdings = [h("UP", 10, 1100), h("DOWN", 10, 900)];
  const hist: HistoricalPrices = { UP: 100, DOWN: 100 }; // both start 1000
  const r = computeContribution(holdings, hist);
  assert.equal(r.totalPortfolioDollarChange, 0);
  for (const x of r.holdings) {
    assert.equal(x.percentOfTotalChange, null); // guarded, never Infinity/NaN
  }
  // But there IS movement to attribute — totalAbsChange = 200 — so concentration
  // still resolves off the absolute denominator.
  assert.equal(r.totalAbsChange, 200);
  assert.ok(r.concentration);
});

test("zero shares never divides by zero", () => {
  const holdings = [h("ZERO", 0, 0)];
  const hist: HistoricalPrices = { ZERO: 50 };
  const r = computeContribution(holdings, hist);
  assert.equal(r.holdings[0].startValue, 0);
  assert.equal(r.holdings[0].dollarContribution, 0);
  assert.equal(r.holdings[0].percentReturn, null); // startValue 0 → guarded
});

test("case-insensitive ticker lookup against the historical map", () => {
  const holdings = [h("aapl", 10, 1200)];
  const hist: HistoricalPrices = { AAPL: 100 };
  const r = computeContribution(holdings, hist);
  assert.equal(r.holdings[0].hasData, true);
  assert.equal(r.holdings[0].dollarContribution, 200);
});

test("concentration: a few holdings crossing the 80% threshold, no-data excluded", () => {
  // One dominant mover (+900) plus three tiny ones (+30 each = 90). Total abs
  // 990; the top holding alone is ~91% ≥ 80%, so topN = 1.
  const holdings = [
    h("BIG", 10, 1900), // +900 from start 1000
    h("A", 10, 130), // +30 from 100
    h("B", 10, 130),
    h("C", 10, 130),
    h("NODATA", 5, 500), // no historical price
  ];
  const hist: HistoricalPrices = { BIG: 100, A: 10, B: 10, C: 10 };
  const r = computeContribution(holdings, hist);
  assert.ok(r.concentration);
  assert.equal(r.concentration!.topN, 1);
  assert.equal(r.concentration!.holdingsWithData, 4); // NODATA excluded
  assert.ok(r.concentration!.coverageFraction >= CONCENTRATION_THRESHOLD);
});

test("concentration is null when there is no movement at all", () => {
  const holdings = [h("FLAT", 10, 1000)];
  const hist: HistoricalPrices = { FLAT: 100 }; // start 1000 == current 1000
  const r = computeContribution(holdings, hist);
  assert.equal(r.totalAbsChange, 0);
  assert.equal(r.concentration, null);
});

test("empty holdings: safe zeros and null concentration", () => {
  const r = computeContribution([], {});
  assert.deepEqual(r.holdings, []);
  assert.equal(r.totalPortfolioDollarChange, 0);
  assert.equal(r.totalPortfolioPercentChange, null);
  assert.equal(r.concentration, null);
});

test("closeOnOrBefore: picks the latest trading day at or before the target", () => {
  const series = [
    { date: "2026-07-06", close: 100 },
    { date: "2026-07-07", close: 101 },
    { date: "2026-07-10", close: 105 }, // weekend gap before target
    { date: "2026-07-13", close: 110 },
  ];
  // Target 2026-07-12 is a weekend — closest prior trading day is the 10th.
  assert.equal(closeOnOrBefore(series, "2026-07-12"), 105);
  // Exact match on a trading day.
  assert.equal(closeOnOrBefore(series, "2026-07-07"), 101);
});

test("closeOnOrBefore: null when the series starts after the target (no early history)", () => {
  const series = [
    { date: "2026-07-10", close: 105 },
    { date: "2026-07-13", close: 110 },
  ];
  assert.equal(closeOnOrBefore(series, "2026-07-01"), null);
});

test("closeOnOrBefore: empty series is null, never a crash", () => {
  assert.equal(closeOnOrBefore([], "2026-07-10"), null);
});

test("formatContributionAnswer: summarizes the move, top movers, and concentration", () => {
  const result = computeContribution(
    [h("BIG", 10, 1900), h("A", 10, 130), h("B", 10, 130), h("NODATA", 5, 500)],
    { BIG: 100, A: 10, B: 10 }
  );
  const answer = formatContributionAnswer({ ...result, period: "1w" });
  assert.match(answer, /past week/);
  assert.match(answer, /BIG \+\$900/);
  assert.match(answer, /account for/);
  assert.match(answer, /No price data over the past week for NODATA/);
});

test("formatContributionAnswer: no-data-only portfolio degrades to a clear message", () => {
  const result = computeContribution([h("NEW", 5, 500)], {}); // no historical price
  const answer = formatContributionAnswer({ ...result, period: "1m" });
  assert.match(answer, /No price history is available/);
});
