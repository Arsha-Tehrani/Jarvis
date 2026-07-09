import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAlphaVantageDaily, shouldFetch } from "../lib/stocks/history-core.ts";

// The whole point of the cache (Alpha Vantage free tier is 25 req/day) is
// "fetch at most once per ticker per calendar day" — these pin that
// decision without needing a DB or network.

test("same calendar day as the cached fetch → serve cache, don't fetch", () => {
  assert.equal(shouldFetch("2026-07-08", "2026-07-08"), false);
});

test("a different (older) day → fetch fresh", () => {
  assert.equal(shouldFetch("2026-07-07", "2026-07-08"), true);
});

test("no cache at all (null) → fetch", () => {
  assert.equal(shouldFetch(null, "2026-07-08"), true);
});

// parseAlphaVantageDaily: independent of which of TIME_SERIES_DAILY /
// TIME_SERIES_DAILY_ADJUSTED is actually free on a given key (Phase 0's
// unresolved question), the response-shape handling itself is fully
// deterministic and testable against fixture bodies.

test("valid response: extracts close prices, sorted oldest first", () => {
  const points = parseAlphaVantageDaily(
    {
      "Time Series (Daily)": {
        "2026-07-08": { "4. close": "420.50" },
        "2026-07-07": { "4. close": "418.10" },
      },
    },
    "VOO"
  );
  assert.deepEqual(points, [
    { date: "2026-07-07", close: 418.1 },
    { date: "2026-07-08", close: 420.5 },
  ]);
});

test("premium-gated endpoint response (Information field) throws a clear error, not a crash", () => {
  assert.throws(
    () =>
      parseAlphaVantageDaily(
        { Information: "This is a premium endpoint. You may subscribe to..." },
        "VOO"
      ),
    /premium endpoint/i
  );
});

test("rate-limit response (Note field) throws a clear quota message", () => {
  assert.throws(
    () => parseAlphaVantageDaily({ Note: "Thank you for using Alpha Vantage..." }, "VOO"),
    /25 requests\/day/i
  );
});

test("unknown symbol (no Time Series key at all) throws, doesn't return an empty chart silently", () => {
  assert.throws(() => parseAlphaVantageDaily({}, "BOGUSTICKER"), /unknown symbol/i);
});

test("a day with a non-numeric close is dropped, not NaN-poisoned into the series", () => {
  const points = parseAlphaVantageDaily(
    {
      "Time Series (Daily)": {
        "2026-07-08": { "4. close": "420.50" },
        "2026-07-07": { "4. close": "n/a" },
      },
    },
    "VOO"
  );
  assert.deepEqual(points, [{ date: "2026-07-08", close: 420.5 }]);
});
