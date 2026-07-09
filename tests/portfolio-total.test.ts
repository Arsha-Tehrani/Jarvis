import assert from "node:assert/strict";
import { test } from "node:test";
import { computePortfolioTotal, type QuoteLookup } from "../lib/stocks/portfolio-total.ts";

// The bug this module fixes: the Today card summed only quote-priced
// holdings and silently dropped anything unpriced, while /api/stocks and
// net worth both fell back to cost basis per holding. These cases pin the
// correct (fallback, never-drop) behavior all three call sites now share.

test("all holdings priced by live quote", () => {
  const getQuote: QuoteLookup = (t) =>
    t === "VOO" ? { price: 420, change: 2, changePercent: 0.5 } : undefined;
  const result = computePortfolioTotal([{ ticker: "VOO", shares: 10, cost_basis: 400 }], getQuote);
  assert.equal(result.totalValue, 4200);
  assert.equal(result.totalDayMove, 20);
  assert.equal(result.pricedBy, "market");
  assert.equal(result.holdings[0].priced, true);
  assert.equal(result.holdings[0].pl, 200);
});

test("a holding with no live quote falls back to cost basis instead of being dropped", () => {
  const getQuote: QuoteLookup = () => undefined; // e.g. SPAXX — no Finnhub symbol
  const result = computePortfolioTotal(
    [{ ticker: "SPAXX", shares: 231.47, cost_basis: 1 }],
    getQuote
  );
  assert.equal(result.totalValue, 231.47);
  assert.equal(result.totalDayMove, 0);
  assert.equal(result.pricedBy, "cost-basis");
  assert.equal(result.holdings[0].priced, false);
  assert.equal(result.holdings[0].price, null);
  assert.equal(result.holdings[0].dayMove, null);
});

test("mixed set: the total includes BOTH market-priced and cost-basis holdings — never drops either", () => {
  const getQuote: QuoteLookup = (t) =>
    t === "VOO" ? { price: 420, change: 2, changePercent: 0.5 } : undefined;
  const result = computePortfolioTotal(
    [
      { ticker: "VOO", shares: 10, cost_basis: 400 },
      { ticker: "SPAXX", shares: 231.47, cost_basis: 1 },
    ],
    getQuote
  );
  // This is the exact regression: 4200 (market) + 231.47 (cost basis) — the
  // old Today-card logic would have reported 4200 alone, silently dropping
  // SPAXX because it iterated over "covered" holdings only.
  assert.equal(result.totalValue, 4200 + 231.47);
  assert.equal(result.totalDayMove, 20); // only the priced holding contributes a day move
  assert.equal(result.pricedBy, "mixed");
});

test("no holdings at all", () => {
  const result = computePortfolioTotal([], () => undefined);
  assert.equal(result.totalValue, 0);
  assert.equal(result.pricedBy, "none");
});

test("cost basis of 0 (money-market core) never divides by zero for plPercent", () => {
  const getQuote: QuoteLookup = () => ({ price: 1, change: 0, changePercent: 0 });
  const result = computePortfolioTotal([{ ticker: "SPAXX", shares: 100, cost_basis: 0 }], getQuote);
  assert.equal(result.holdings[0].plPercent, null);
  assert.equal(result.holdings[0].pl, 100); // (1 - 0) * 100 — pl itself is still meaningful
});

test("ticker lookup is case-insensitive (quote map keyed by uppercase)", () => {
  const getQuote: QuoteLookup = (t) => (t === "VOO" ? { price: 420, change: 2, changePercent: 0.5 } : undefined);
  const result = computePortfolioTotal([{ ticker: "voo", shares: 1, cost_basis: 400 }], getQuote);
  assert.equal(result.holdings[0].priced, true);
  assert.equal(result.totalValue, 420);
});
