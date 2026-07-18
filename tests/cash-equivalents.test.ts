import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isKnownCashEquivalent,
  splitStocksAndCashEquivalent,
} from "../lib/stocks/cash-equivalents.ts";

test("isKnownCashEquivalent: known money-market/sweep tickers match", () => {
  assert.equal(isKnownCashEquivalent("SPAXX"), true);
  assert.equal(isKnownCashEquivalent("VMFXX"), true);
  assert.equal(isKnownCashEquivalent("SWVXX"), true);
});

test("isKnownCashEquivalent: case-insensitive", () => {
  assert.equal(isKnownCashEquivalent("spaxx"), true);
  assert.equal(isKnownCashEquivalent("SpAxX"), true);
});

test("isKnownCashEquivalent: an unknown/equity ticker defaults to false (stock)", () => {
  assert.equal(isKnownCashEquivalent("AAPL"), false);
  assert.equal(isKnownCashEquivalent("VOO"), false);
  assert.equal(isKnownCashEquivalent("NOTAREALTICKER"), false);
});

test("splitStocksAndCashEquivalent: all stocks, no cash-equivalent", () => {
  const r = splitStocksAndCashEquivalent([
    { value: 1000, is_cash_equivalent: 0 },
    { value: 500, is_cash_equivalent: false },
  ]);
  assert.equal(r.stocksValue, 1500);
  assert.equal(r.cashEquivalentValue, 0);
});

test("splitStocksAndCashEquivalent: all cash-equivalent, no stocks", () => {
  const r = splitStocksAndCashEquivalent([
    { value: 300, is_cash_equivalent: 1 },
    { value: 200, is_cash_equivalent: true },
  ]);
  assert.equal(r.stocksValue, 0);
  assert.equal(r.cashEquivalentValue, 500);
});

test("splitStocksAndCashEquivalent: mixed — SPAXX-like fixture alongside a real ticker", () => {
  const r = splitStocksAndCashEquivalent([
    { value: 4200, is_cash_equivalent: 0 }, // e.g. VOO
    { value: 231.47, is_cash_equivalent: 1 }, // e.g. SPAXX
  ]);
  assert.equal(r.stocksValue, 4200);
  assert.equal(r.cashEquivalentValue, 231.47);
  // The two always sum back to the portfolio's total value.
  assert.equal(r.stocksValue + r.cashEquivalentValue, 4200 + 231.47);
});

test("splitStocksAndCashEquivalent: empty holdings list is safe zeros", () => {
  const r = splitStocksAndCashEquivalent([]);
  assert.equal(r.stocksValue, 0);
  assert.equal(r.cashEquivalentValue, 0);
});
