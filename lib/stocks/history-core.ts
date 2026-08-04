// Pure pieces of click-to-chart history: no DB/network imports, so
// `node --test` can exercise them directly (mirrors lib/sync/core.ts's
// split — the pure engine here, the DB/network glue in history.ts).

// `date` is a plain YYYY-MM-DD for daily/weekly/monthly granularity and a
// full ISO timestamp for intraday bars (the tooltip needs the time of day).
export type PricePoint = { date: string; close: number };

// ---------------------------------------------------------------------------
// Timeframe → fetch plan
// ---------------------------------------------------------------------------

export const TIMEFRAMES = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export type Interval = "5m" | "15m" | "30m" | "1d" | "1wk" | "1mo";

const INTRADAY = new Set<Interval>(["5m", "15m", "30m"]);

export function isIntraday(interval: Interval): boolean {
  return INTRADAY.has(interval);
}

// One resolved chart request. `period1/period2` is the FETCH range — for 1d
// it's deliberately a superset (the full year every daily timeframe needs),
// so 3M/6M/YTD/1Y all hit the same (ticker, '1d') cache entry and only
// `displayFrom` differs. The display shaping is separate and pure
// (applyDisplay below):
//   displayFrom  — drop points before this YYYY-MM-DD (daily-superset slice)
//   sessions     — keep only the last N distinct trading days (1D=1, 5D=5;
//                  the fetch window is padded past weekends/holidays, so
//                  "last session" can't come back empty on a Sunday)
// `fallback` is the next-coarser plan to try when the intraday request
// errors or returns nothing (market closed too long, thin symbol, Yahoo
// mood) — always a 1d plan reusing the shared daily superset, with a label
// the UI must show so degraded granularity is never silent.
export type ChartPlan = {
  timeframe: Timeframe;
  interval: Interval;
  period1: string; // ISO — fetch start
  period2: string; // ISO — fetch end (now)
  displayFrom?: string; // YYYY-MM-DD
  sessions?: number;
  fallback?: { plan: ChartPlan; label: string };
};

const DAY_MS = 86_400_000;

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

// Yahoo's real per-interval lookback limits (upstream, not configurable):
// ≤30m intervals serve only ~60 days back; 1d/1wk/1mo serve full history.
// Every intraday window below stays well inside 60 days by construction.
export function resolveInterval(timeframe: Timeframe, now: Date): ChartPlan {
  const nowIso = now.toISOString();
  // Shared daily superset: one fetch covers every 1d timeframe (3M/6M/YTD/1Y
  // and the intraday fallbacks), so switching tabs is a cache hit.
  const daily = (tf: Timeframe, displayFrom: string): ChartPlan => ({
    timeframe: tf,
    interval: "1d",
    period1: daysAgo(now, 370),
    period2: nowIso,
    displayFrom,
  });
  // Intraday fallback: same timeframe button, coarser data — one month of
  // daily closes rather than a blank chart, labeled so it's never silent.
  const dailyFallback = (tf: Timeframe): ChartPlan["fallback"] => ({
    plan: daily(tf, daysAgo(now, 35).slice(0, 10)),
    label: "intraday unavailable — showing 1 month, daily",
  });

  switch (timeframe) {
    case "1D":
      return {
        timeframe,
        interval: "5m",
        period1: daysAgo(now, 6), // pad past weekends/holidays
        period2: nowIso,
        sessions: 1,
        fallback: dailyFallback(timeframe),
      };
    case "5D":
      return {
        timeframe,
        interval: "15m",
        period1: daysAgo(now, 14),
        period2: nowIso,
        sessions: 5,
        fallback: dailyFallback(timeframe),
      };
    case "1M":
      return {
        timeframe,
        interval: "30m",
        period1: daysAgo(now, 32), // safely under the ~60-day 30m cap
        period2: nowIso,
        fallback: dailyFallback(timeframe),
      };
    case "3M":
      return daily(timeframe, daysAgo(now, 92).slice(0, 10));
    case "6M":
      return daily(timeframe, daysAgo(now, 183).slice(0, 10));
    case "YTD":
      return daily(timeframe, `${now.getUTCFullYear()}-01-01`);
    case "1Y":
      return daily(timeframe, daysAgo(now, 365).slice(0, 10));
    case "5Y":
      return {
        timeframe,
        interval: "1wk",
        period1: daysAgo(now, 5 * 366),
        period2: nowIso,
      };
    case "MAX":
      return {
        timeframe,
        interval: "1mo",
        period1: "1970-01-01T00:00:00.000Z",
        period2: nowIso,
      };
  }
}

// Shapes a cached/fetched superset series into what one timeframe displays.
// Pure and order-preserving; assumes points are sorted oldest-first (which
// parseYahooChart guarantees).
export function applyDisplay(points: PricePoint[], plan: ChartPlan): PricePoint[] {
  let out = points;
  if (plan.displayFrom) {
    const from = plan.displayFrom;
    out = out.filter((p) => p.date.slice(0, 10) >= from);
  }
  if (plan.sessions != null) {
    const days = [...new Set(out.map((p) => p.date.slice(0, 10)))];
    const keep = new Set(days.slice(-plan.sessions));
    out = out.filter((p) => keep.has(p.date.slice(0, 10)));
  }
  return out;
}

// Yahoo reports mutual funds (SPAXX, FXAIX, …) as having intraday data but
// serves a single NAV bar or a small handful — a one-dot "chart". Verified
// live 2026-07-12: FXAIX 1D returned exactly 1 five-minute bar. Treat a
// sparse AND stale intraday series as unavailable so the caller degrades to
// the labeled daily fallback; sparse but *fresh* (the market opened minutes
// ago, bars still accumulating) is a legitimately short session and must
// NOT degrade.
export function isSparseIntraday(points: PricePoint[], now: Date): boolean {
  if (points.length >= 3) return false;
  if (points.length === 0) return true;
  const last = Date.parse(points[points.length - 1].date);
  return !Number.isFinite(last) || now.getTime() - last > 2 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Cache freshness
// ---------------------------------------------------------------------------

// One rule per granularity, in one place:
//   1d/1wk/1mo — EOD data doesn't change until market close, so any
//     same-UTC-calendar-day entry is fresh (the original per-ticker-per-day
//     rule, now per interval too).
//   5m/15m/30m — intraday bars keep changing while the market is open, so
//     these ride the same 15-minute cadence as the live-quote cache rather
//     than inventing a new rhythm.
// A malformed/missing fetched_at is simply stale — refetch, never throw.
export const INTRADAY_TTL_MS = 15 * 60 * 1000;

export function isCacheFresh(interval: Interval, fetchedAt: string | null, now: Date): boolean {
  if (!fetchedAt) return false;
  if (isIntraday(interval)) {
    const age = now.getTime() - Date.parse(fetchedAt);
    return Number.isFinite(age) && age >= 0 && age < INTRADAY_TTL_MS;
  }
  return fetchedAt.slice(0, 10) === now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Yahoo chart() response parsing
// ---------------------------------------------------------------------------

// The subset of yahoo-finance2's chart() result this app reads. quotes[].date
// arrives as a JS Date (bar timestamp); it may also be an ISO string if a
// result was serialized in between.
export type YahooChartQuote = {
  date: Date | string;
  close?: number | null;
  adjclose?: number | null;
};
export type YahooChartResult = { quotes?: YahooChartQuote[] };

// Turns one yahoo-finance2 chart() result into points or a clear thrown
// error — directly testable against fixture objects, never a live call
// (unofficial-API rule). Raw close is used (matching what the chart always
// showed); adjclose only fills in when close is missing for a bar.
// Daily granularity keys points by calendar date; intraday keeps the full
// timestamp so the tooltip can show time of day.
export function parseYahooChart(
  result: YahooChartResult,
  ticker: string,
  granularity: "daily" | "intraday" = "daily"
): PricePoint[] {
  const points: PricePoint[] = (result.quotes ?? [])
    .map((q) => {
      // Note: Number(null) is 0 — a no-price bar must become NaN (dropped
      // below), never a phantom $0 close.
      const raw = q.close ?? q.adjclose;
      const iso = q.date instanceof Date ? q.date.toISOString() : String(q.date);
      return {
        date: granularity === "intraday" ? iso : iso.slice(0, 10),
        close: typeof raw === "number" ? raw : NaN,
      };
    })
    .filter((p) => /^\d{4}-\d{2}-\d{2}/.test(p.date) && Number.isFinite(p.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length === 0) {
    throw new Error(`No historical data for ${ticker} (unknown or delisted symbol?)`);
  }
  return points;
}
