import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TIMEFRAMES,
  applyDisplay,
  barSessionDate,
  isCacheFresh,
  isSparseIntraday,
  parseYahooChart,
  resolveInterval,
  type ChartPlan,
  type PricePoint,
} from "../lib/stocks/history-core.ts";

// The caching rule is "fetch at most once per (ticker, interval) per
// freshness window" — a calendar day for EOD granularities (originally to
// stay inside Alpha Vantage's 25-req/day free tier, now to not hammer an
// unofficial Yahoo endpoint), and the existing 15-minute quote cadence for
// intraday. These pin the decisions without a DB or network.

const NOW = new Date("2026-07-12T20:00:00.000Z"); // a Sunday evening

// ---- resolveInterval: the timeframe → interval/range table -----------------

test("every timeframe resolves to its documented interval", () => {
  const expected: Record<string, string> = {
    "1D": "5m",
    "5D": "15m",
    "1M": "30m",
    "3M": "1d",
    "6M": "1d",
    YTD: "1d",
    "1Y": "1d",
    "5Y": "1wk",
    MAX: "1mo",
  };
  for (const tf of TIMEFRAMES) {
    assert.equal(resolveInterval(tf, NOW).interval, expected[tf], tf);
  }
});

test("all 1d timeframes share one fetch range so they hit the same cache entry", () => {
  const plans = (["3M", "6M", "YTD", "1Y"] as const).map((tf) => resolveInterval(tf, NOW));
  const ranges = new Set(plans.map((p) => `${p.period1}..${p.period2}`));
  assert.equal(ranges.size, 1);
  // ...and differ only in the display slice.
  assert.equal(resolveInterval("3M", NOW).displayFrom, "2026-04-11");
  assert.equal(resolveInterval("6M", NOW).displayFrom, "2026-01-10");
  assert.equal(resolveInterval("1Y", NOW).displayFrom, "2025-07-12");
});

test("YTD slices from January 1 of the current (UTC) year", () => {
  assert.equal(resolveInterval("YTD", NOW).displayFrom, "2026-01-01");
});

test("MAX fetches from the epoch at monthly bars", () => {
  const plan = resolveInterval("MAX", NOW);
  assert.equal(plan.period1, "1970-01-01T00:00:00.000Z");
  assert.equal(plan.displayFrom, undefined);
});

test("intraday windows stay inside Yahoo's ~60-day cap for ≤30m intervals", () => {
  for (const tf of ["1D", "5D", "1M"] as const) {
    const plan = resolveInterval(tf, NOW);
    const days = (Date.parse(plan.period2) - Date.parse(plan.period1)) / 86_400_000;
    assert.ok(days <= 60, `${tf} fetches ${days} days — over Yahoo's intraday limit`);
  }
});

test("1D and 5D fetch padded windows but trim to the last 1 / 5 sessions", () => {
  assert.equal(resolveInterval("1D", NOW).sessions, 1);
  assert.equal(resolveInterval("5D", NOW).sessions, 5);
  // Padding matters: on a Sunday, a literal 1-day window would be empty.
  const oneDay = resolveInterval("1D", NOW);
  assert.ok(Date.parse(oneDay.period2) - Date.parse(oneDay.period1) >= 3 * 86_400_000);
});

test("intraday timeframes carry a labeled daily fallback; daily ones don't", () => {
  for (const tf of ["1D", "5D", "1M"] as const) {
    const fb = resolveInterval(tf, NOW).fallback;
    assert.ok(fb, `${tf} must have a fallback`);
    assert.equal(fb.plan.interval, "1d");
    assert.match(fb.label, /intraday unavailable/);
    // The fallback reuses the shared daily superset → cache hit, not a
    // second bespoke fetch.
    assert.equal(fb.plan.period1, resolveInterval("1Y", NOW).period1);
    assert.equal(fb.plan.fallback, undefined); // no fallback chains
  }
  for (const tf of ["3M", "6M", "YTD", "1Y", "5Y", "MAX"] as const) {
    assert.equal(resolveInterval(tf, NOW).fallback, undefined, tf);
  }
});

// ---- applyDisplay: superset series → what one timeframe shows --------------

const daily = (dates: string[]): PricePoint[] => dates.map((d) => ({ date: d, close: 100 }));

test("displayFrom drops older points, keeping the boundary day", () => {
  const plan = { displayFrom: "2026-07-01" } as ChartPlan;
  const out = applyDisplay(daily(["2026-06-30", "2026-07-01", "2026-07-02"]), plan);
  assert.deepEqual(out.map((p) => p.date), ["2026-07-01", "2026-07-02"]);
});

test("sessions keeps only the last N distinct trading days of intraday bars", () => {
  const bars: PricePoint[] = [
    { date: "2026-07-09T13:30:00.000Z", close: 1 },
    { date: "2026-07-10T13:30:00.000Z", close: 2 },
    { date: "2026-07-10T14:00:00.000Z", close: 3 },
    { date: "2026-07-11T13:30:00.000Z", close: 4 },
  ];
  const lastOne = applyDisplay(bars, { sessions: 1 } as ChartPlan);
  assert.deepEqual(lastOne.map((p) => p.close), [4]);
  const lastTwo = applyDisplay(bars, { sessions: 2 } as ChartPlan);
  assert.deepEqual(lastTwo.map((p) => p.close), [2, 3, 4]);
});

// ---- isSparseIntraday: mutual funds "have" intraday but serve 1 NAV bar ----
// (verified live: FXAIX 1D returned exactly one 5m bar on 2026-07-12)

test("a sparse, stale intraday series counts as unavailable → daily fallback", () => {
  const oneOldBar = [{ date: "2026-07-10T20:00:00.000Z", close: 195.2 }]; // Friday NAV
  assert.equal(isSparseIntraday(oneOldBar, NOW), true); // Sunday evening
  assert.equal(isSparseIntraday([], NOW), true);
});

test("a sparse but FRESH series (market opened minutes ago) is legitimate", () => {
  const justOpened = [
    { date: "2026-07-12T19:50:00.000Z", close: 357.1 },
    { date: "2026-07-12T19:55:00.000Z", close: 357.4 },
  ];
  assert.equal(isSparseIntraday(justOpened, NOW), false);
});

test("three or more bars is never sparse, regardless of age", () => {
  const bars = ["13:30", "13:35", "13:40"].map((t) => ({
    date: `2026-07-10T${t}:00.000Z`,
    close: 100,
  }));
  assert.equal(isSparseIntraday(bars, NOW), false);
});

// ---- isCacheFresh: per-granularity freshness --------------------------------

test("EOD intervals: fresh iff fetched the same UTC calendar day", () => {
  assert.equal(isCacheFresh("1d", "2026-07-12T01:00:00.000Z", NOW), true);
  assert.equal(isCacheFresh("1wk", "2026-07-11T23:59:00.000Z", NOW), false);
  assert.equal(isCacheFresh("1mo", null, NOW), false);
});

test("intraday intervals: fresh for 15 minutes, the live-quote cadence", () => {
  assert.equal(isCacheFresh("5m", "2026-07-12T19:50:00.000Z", NOW), true); // 10 min old
  assert.equal(isCacheFresh("15m", "2026-07-12T19:44:00.000Z", NOW), false); // 16 min old
  assert.equal(isCacheFresh("30m", "garbage", NOW), false); // malformed = stale, never throw
  // A future timestamp (clock skew) is also just stale.
  assert.equal(isCacheFresh("5m", "2026-07-12T21:00:00.000Z", NOW), false);
});

// ---- parseYahooChart: fixture objects shaped like yahoo-finance2 chart()
// results — never a live call (unofficial-API rule, same as the LeetCode
// puller and the old Alpha Vantage parser before it). ------------------------

test("valid chart result: extracts close prices keyed by calendar date, sorted oldest first", () => {
  const points = parseYahooChart(
    {
      quotes: [
        // date is a JS Date at market open (13:30Z in summer) — must become
        // a plain YYYY-MM-DD at daily granularity.
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

test("intraday granularity keeps the full bar timestamp for the tooltip", () => {
  const points = parseYahooChart(
    {
      quotes: [
        { date: new Date("2026-07-08T14:35:00.000Z"), close: 421.2 },
        { date: new Date("2026-07-08T13:30:00.000Z"), close: 420.5 },
      ],
    },
    "VOO",
    "intraday"
  );
  assert.deepEqual(points, [
    { date: "2026-07-08T13:30:00.000Z", close: 420.5 },
    { date: "2026-07-08T14:35:00.000Z", close: 421.2 },
  ]);
});

test("ISO-string dates (a serialized result) parse the same as Date objects", () => {
  const points = parseYahooChart(
    { quotes: [{ date: "2026-07-08T13:30:00.000Z", close: 420.5 }] },
    "VOO"
  );
  assert.deepEqual(points, [{ date: "2026-07-08", close: 420.5 }]);
});

test("a bar with a null close falls back to adjclose", () => {
  const points = parseYahooChart(
    { quotes: [{ date: new Date("2026-07-08T13:30:00.000Z"), close: null, adjclose: 419.9 }] },
    "VOO"
  );
  assert.deepEqual(points, [{ date: "2026-07-08", close: 419.9 }]);
});

test("a bar with no usable price at all is dropped, not NaN-poisoned into the series", () => {
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

// ---- sessions are MARKET-LOCAL dates, not UTC ------------------------------
// Regression for a live failure found 2026-11-15: a US session's after-hours
// tail (16:00–20:00 ET) is stamped on the NEXT UTC date, so a UTC-keyed
// `sessions: 1` selected only those post-market prints and discarded the
// whole regular session. GOOGL's Friday 2026-11-13 5m series ended with 13
// bars at 2026-11-14T00:00–00:59Z (19:00–19:59 ET); `sessions: 1` returned
// exactly those 13 instead of the ~79 regular-session bars.

test("sessions keys on the ET session date, so after-hours bars don't become their own session", () => {
  const bars: PricePoint[] = [
    { date: "2026-11-13T14:30:00.000Z", close: 1 }, // 09:30 ET — the open
    { date: "2026-11-13T21:00:00.000Z", close: 2 }, // 16:00 ET — the close
    { date: "2026-11-14T00:00:00.000Z", close: 3 }, // 19:00 ET — after-hours
    { date: "2026-11-14T00:59:58.000Z", close: 4 }, // 19:59 ET — after-hours
  ];
  // All four belong to the SAME ET session (2026-11-13), so sessions:1 keeps
  // all of them — never just the two that happen to carry a UTC date of the
  // 14th.
  const lastOne = applyDisplay(bars, { sessions: 1 } as ChartPlan);
  assert.deepEqual(
    lastOne.map((p) => p.close),
    [1, 2, 3, 4]
  );
});

test("barSessionDate maps an instant to its ET session, and leaves a plain date alone", () => {
  assert.equal(barSessionDate("2026-11-14T00:59:58.000Z"), "2026-11-13"); // 19:59 ET
  assert.equal(barSessionDate("2026-11-13T14:30:00.000Z"), "2026-11-13"); // 09:30 ET
  // A daily bar's date is already a session date — no timezone shift.
  assert.equal(barSessionDate("2026-11-13"), "2026-11-13");
});
