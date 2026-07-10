import { getDb } from "@/lib/db";
import { yahooFinance } from "@/lib/stocks/yahoo-client";
import {
  parseYahooChart,
  shouldFetch,
  type YahooChartResult,
  type PricePoint,
} from "./history-core";

// Click-to-chart daily price history via yahoo-finance2 (no API key needed —
// see docs/stock-history-feasibility.md for the history of this path: it was
// Alpha Vantage-only until fix-plan-3 Phase 5). Fetching stays lazy (on
// click) with a persistent per-ticker-per-day cache: the reason shifted from
// "stay inside a 25-req/day free tier" to "don't hammer an unofficial
// endpoint and keep ticker clicks fast", but the mechanism is unchanged.
// Pure decision/parsing logic lives in history-core.ts (unit-tested there);
// this file is the DB + network glue, same split as lib/sync/core.ts vs.
// lib/sync/client.ts.

export { type PricePoint } from "./history-core";

// ~100 most recent trading days (what Alpha Vantage "compact" served) —
// plenty for the chart dialog.
const LOOKBACK_DAYS = 150;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getCachedHistory(ticker: string): PricePoint[] | null {
  const row = getDb()
    .prepare("SELECT fetched_date, series FROM stock_history_cache WHERE ticker = ?")
    .get(ticker.toUpperCase()) as { fetched_date: string; series: string } | undefined;
  if (!row || shouldFetch(row.fetched_date, todayIso())) return null;
  return JSON.parse(row.series) as PricePoint[];
}

function cacheHistory(ticker: string, series: PricePoint[]): void {
  getDb()
    .prepare(
      `INSERT INTO stock_history_cache (ticker, fetched_date, series) VALUES (?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET fetched_date = excluded.fetched_date, series = excluded.series`
    )
    .run(ticker.toUpperCase(), todayIso(), JSON.stringify(series));
}

// Serves the same-day cache when warm; otherwise one chart() call through
// the shared Yahoo client (lib/stocks/yahoo-client.ts — audited via
// loggedFetch), cached for the rest of today. Any thrown error (HTTP,
// validation, delisted/unknown symbol) propagates to the API route, which
// renders it as the chart dialog's calm degraded state — never a crash.
export async function getStockHistory(ticker: string): Promise<PricePoint[]> {
  const cached = getCachedHistory(ticker);
  if (cached) return cached;

  const period1 = new Date(Date.now() - LOOKBACK_DAYS * 86400_000);
  const result = await yahooFinance.chart(ticker.toUpperCase(), {
    period1,
    period2: new Date(),
    interval: "1d",
  });
  const points = parseYahooChart(result as YahooChartResult, ticker);
  cacheHistory(ticker, points);
  return points;
}
