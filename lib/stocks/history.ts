import { getDb } from "@/lib/db";
import { loggedFetch } from "@/lib/network-log";
import {
  HistoryNotConfiguredError,
  parseAlphaVantageDaily,
  shouldFetch,
  type AlphaVantageDailyResponse,
  type PricePoint,
} from "./history-core";

// Click-to-chart daily price history. See docs/stock-history-feasibility.md
// for why this is Alpha Vantage only (Finnhub's /stock/candle is confirmed
// premium-gated on free keys) and why fetching is lazy (on click) with a
// persistent per-ticker-per-day cache rather than proactive on page load —
// the free tier is 25 requests/day, shared with quote-fallback usage.
// Pure decision/parsing logic lives in history-core.ts (unit-tested there);
// this file is the DB + network glue, same split as lib/sync/core.ts vs.
// lib/sync/client.ts.

export { HistoryNotConfiguredError, type PricePoint } from "./history-core";

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

// Serves the same-day cache when warm; otherwise fetches Alpha Vantage and
// caches for the rest of today. TIME_SERIES_DAILY_ADJUSTED is tried first —
// see history-core.ts's parseAlphaVantageDaily for why the endpoint choice
// doesn't matter for correctness, only for whether this succeeds at all on
// a given key.
export async function getStockHistory(ticker: string): Promise<PricePoint[]> {
  const cached = getCachedHistory(ticker);
  if (cached) return cached;

  if (!process.env.ALPHAVANTAGE_API_KEY) throw new HistoryNotConfiguredError();

  const params = new URLSearchParams({
    function: "TIME_SERIES_DAILY_ADJUSTED",
    symbol: ticker.toUpperCase(),
    outputsize: "compact", // ~100 most recent trading days — plenty for a chart
    apikey: process.env.ALPHAVANTAGE_API_KEY,
  });
  const res = await loggedFetch(`https://www.alphavantage.co/query?${params}`, undefined, {
    feature: "stock-history",
    purpose: "fetch daily price history",
  });
  if (!res.ok) throw new Error(`Alpha Vantage responded ${res.status} for ${ticker}`);
  const data = (await res.json()) as AlphaVantageDailyResponse;
  const points = parseAlphaVantageDaily(data, ticker);
  cacheHistory(ticker, points);
  return points;
}
