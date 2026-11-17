import { getDb } from "@/lib/db";
import { yahooFinance } from "@/lib/stocks/yahoo-client";
import {
  applyDisplay,
  isCacheFresh,
  isIntraday,
  isSparseIntraday,
  parseYahooChart,
  resolveInterval,
  type ChartPlan,
  type Interval,
  type PricePoint,
  type Timeframe,
  type YahooChartResult,
} from "./history-core";

// Click-to-chart price history via yahoo-finance2 (no API key needed — see
// docs/stock-history-feasibility.md). Multi-timeframe: the dialog picks a
// timeframe (1D…MAX), history-core.ts resolves it to an interval + fetch
// range (pure, unit-tested), and this file is the DB + network glue — same
// split as lib/sync/core.ts vs. lib/sync/client.ts. Fetching stays lazy (on
// click / tab change) with a persistent per-(ticker, interval) cache; EOD
// intervals are cached for the calendar day, intraday for 15 minutes (the
// live-quote cadence). The reason is unchanged since the Alpha Vantage era:
// don't hammer an unofficial endpoint, keep ticker clicks fast.

export { type PricePoint, type Timeframe } from "./history-core";

export type StockChart = {
  timeframe: Timeframe;
  interval: Interval;
  series: PricePoint[];
  // Human label when the intraday request degraded to daily bars — the UI
  // must render it (degraded granularity is never silent).
  fallback: string | null;
  // The UNSHAPED series for `interval`: everything fetched/cached before
  // applyDisplay's displayFrom/sessions trim. `series` is a window onto this.
  //
  // Exposed for one caller: the portfolio 1D range needs each ticker's
  // PREVIOUS session close, and a 1D plan's fetch window is already a 6-day
  // 5m superset (padded past weekends), so the prior session is sitting in
  // here — reading it costs no extra Yahoo call and keeps the chart's bars
  // and its baseline on the SAME provider. The per-ticker dialog ignores it.
  superset: PricePoint[];
};

function readCache(ticker: string, interval: Interval, now: Date): PricePoint[] | null {
  const row = getDb()
    .prepare("SELECT fetched_at, series FROM stock_chart_cache WHERE ticker = ? AND interval = ?")
    .get(ticker, interval) as { fetched_at: string; series: string } | undefined;
  if (!row || !isCacheFresh(interval, row.fetched_at, now)) return null;
  return JSON.parse(row.series) as PricePoint[];
}

function writeCache(ticker: string, interval: Interval, series: PricePoint[], now: Date): void {
  getDb()
    .prepare(
      `INSERT INTO stock_chart_cache (ticker, interval, fetched_at, series) VALUES (?, ?, ?, ?)
       ON CONFLICT(ticker, interval) DO UPDATE SET fetched_at = excluded.fetched_at, series = excluded.series`
    )
    .run(ticker, interval, now.toISOString(), JSON.stringify(series));
}

// One plan → displayed points: serve the fresh cache or make one chart()
// call through the shared audited Yahoo client, cache the raw superset, then
// slice/trim for the timeframe (pure). Throws on fetch/parse failure —
// including "no data", so the caller can decide whether a fallback applies.
type FetchedPlan = { shown: PricePoint[]; superset: PricePoint[] };

async function fetchPlan(ticker: string, plan: ChartPlan, now: Date): Promise<FetchedPlan> {
  const cached = readCache(ticker, plan.interval, now);
  let points = cached;
  if (!points) {
    const result = await yahooFinance.chart(ticker, {
      period1: new Date(plan.period1),
      period2: new Date(plan.period2),
      interval: plan.interval,
    });
    points = parseYahooChart(
      result as YahooChartResult,
      ticker,
      isIntraday(plan.interval) ? "intraday" : "daily"
    );
    writeCache(ticker, plan.interval, points, now);
  }
  const shown = applyDisplay(points, plan);
  // Empty window (fresh cache from a stale market) or a sparse-and-stale
  // intraday series (mutual funds "have" intraday but serve one NAV bar):
  // throw rather than render a blank/one-dot chart — the caller degrades to
  // the labeled daily fallback when the plan has one.
  if (shown.length === 0) {
    throw new Error(`No ${plan.interval} data for ${ticker} in the ${plan.timeframe} window`);
  }
  if (isIntraday(plan.interval) && isSparseIntraday(shown, now)) {
    throw new Error(`Only ${shown.length} stale ${plan.interval} bar(s) for ${ticker}`);
  }
  return { shown, superset: points };
}

// The dialog's one entry point. Intraday plans degrade to their labeled
// daily fallback when the intraday request errors or comes back empty
// (market closed, thin symbol, Yahoo mood) — a confident blank chart is
// worse than a clear "showing daily" note. Daily plans have no fallback:
// their errors (unknown/delisted symbol, network) propagate to the API
// route, which renders the calm degraded message.
export async function getStockChart(
  ticker: string,
  timeframe: Timeframe,
  now: Date = new Date()
): Promise<StockChart> {
  const upper = ticker.toUpperCase();
  const plan = resolveInterval(timeframe, now);
  try {
    const { shown, superset } = await fetchPlan(upper, plan, now);
    return { timeframe, interval: plan.interval, series: shown, fallback: null, superset };
  } catch (err) {
    if (!plan.fallback) throw err;
    console.warn(
      `[stock-history] ${upper} ${timeframe}: ${plan.interval} unavailable (${
        err instanceof Error ? err.message : err
      }) — falling back to daily`
    );
    const { shown, superset } = await fetchPlan(upper, plan.fallback.plan, now);
    return {
      timeframe,
      interval: plan.fallback.plan.interval,
      series: shown,
      fallback: plan.fallback.label,
      superset,
    };
  }
}
