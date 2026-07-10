import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYahooChart, shouldFetch } from "../lib/stocks/history-core.ts";

// The whole point of the cache is "fetch at most once per ticker per
// calendar day" — originally to stay inside Alpha Vantage's 25-req/day free
// tier, now (Yahoo) to not hammer an unofficial endpoint. These pin that
// decision without needing a DB or network, and pass unmodified across the
// Alpha Vantage → yahoo-finance2 migration (fix-plan-3 Phase 5) — the
// caching mechanism is deliberately unchanged.

test("same calendar day as the cached fetch → serve cache, don't fetch", () => {
  assert.equal(shouldFetch("2026-07-08", "2026-07-08"), false);
});

test("a different (older) day → fetch fresh", () => {
  assert.equal(shouldFetch("2026-07-07", "2026-07-08"), true);
});

test("no cache at all (null) → fetch", () => {
  assert.equal(shouldFetch(null, "2026-07-08"), true);
});

// parseYahooChart: fixture objects shaped like yahoo-finance2 chart()
// results — never a live call (unofficial-API rule, same as the LeetCode
// puller and the old Alpha Vantage parser before it).

test("valid chart result: extracts close prices keyed by calendar date, sorted oldest first", () => {
  const points = parseYahooChart(
    {
      quotes: [
        // date is a JS Date at market open (13:30Z in summer) — must become
        // a plain YYYY-MM-DD.
        { date: new Date("2026-07-08T13:30:00.000Z"), close: 420.5, adjclose: 420.5 },
        { date: new Date("2026-07-07T13:30:00.000Z"), close: 418.1, adjclose: 418.1 },
      ],
    },
    "VOO"
  );
  assert.deepEqual(points, [
    { date: "2026-07-07", close: 418.1 },
    { date: "2026-07-08", close: 420.5 },
  ]);
});

test("ISO-string dates (a serialized result) parse the same as Date objects", () => {
  const points = parseYahooChart(
    { quotes: [{ date: "2026-07-08T13:30:00.000Z", close: 420.5 }] },
    "VOO"
  );
  assert.deepEqual(points, [{ date: "2026-07-08", close: 420.5 }]);
});

test("a day with a null close falls back to adjclose", () => {
  const points = parseYahooChart(
    { quotes: [{ date: new Date("2026-07-08T13:30:00.000Z"), close: null, adjclose: 419.9 }] },
    "VOO"
  );
  assert.deepEqual(points, [{ date: "2026-07-08", close: 419.9 }]);
});

test("a day with no usable price at all is dropped, not NaN-poisoned into the series", () => {
  const points = parseYahooChart(
    {
      quotes: [
        { date: new Date("2026-07-08T13:30:00.000Z"), close: 420.5 },
        { date: new Date("2026-07-07T13:30:00.000Z"), close: null, adjclose: null },
      ],
    },
    "VOO"
  );
  assert.deepEqual(points, [{ date: "2026-07-08", close: 420.5 }]);
});

test("empty quotes (delisted/unknown symbol) throws a clear error, not an empty chart", () => {
  assert.throws(() => parseYahooChart({ quotes: [] }, "BOGUSTICKER"), /unknown or delisted/i);
  assert.throws(() => parseYahooChart({}, "BOGUSTICKER"), /unknown or delisted/i);
});
