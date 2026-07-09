// Pure pieces of click-to-chart history: no DB/network imports, so
// `node --test` can exercise them directly (mirrors lib/sync/core.ts's
// split — the pure engine here, the DB/network glue in history.ts).

export type PricePoint = { date: string; close: number };

export class HistoryNotConfiguredError extends Error {
  constructor() {
    super("No Alpha Vantage key — set ALPHAVANTAGE_API_KEY in .env.local to see historical charts");
  }
}

// The whole caching decision in one place. EOD data doesn't change until
// market close regardless of when it was first cached today, so any
// same-calendar-day cache hit is safe to serve — there's no "staler than N
// minutes" concept here like the 15-minute quote cache; it's "already
// fetched today" or not.
export function shouldFetch(cachedDate: string | null, today: string): boolean {
  return cachedDate !== today;
}

export type AlphaVantageDailyResponse = {
  "Time Series (Daily)"?: Record<string, Record<string, string>>;
  Note?: string;
  Information?: string;
};

// Turns one Alpha Vantage response body into points or a clear thrown error.
// The premium-gated / rate-limited / unknown-symbol / happy-path cases are
// all directly testable against fixture JSON, independent of which of
// TIME_SERIES_DAILY / TIME_SERIES_DAILY_ADJUSTED actually turns out to be
// free (see docs/stock-history-feasibility.md — a "premium endpoint"
// response is just another flavor of "unavailable" here, not a special case
// requiring the other endpoint name to be guessed at).
export function parseAlphaVantageDaily(data: AlphaVantageDailyResponse, ticker: string): PricePoint[] {
  if (data.Note) {
    throw new Error("Alpha Vantage daily quota reached (free tier is 25 requests/day) — try again tomorrow");
  }
  if (data.Information) {
    throw new Error(`Alpha Vantage: ${data.Information}`);
  }
  const series = data["Time Series (Daily)"];
  if (!series) throw new Error(`No historical data for ${ticker} (unknown symbol?)`);

  const points: PricePoint[] = Object.entries(series)
    .map(([date, day]) => ({ date, close: Number(day["4. close"]) }))
    .filter((p) => Number.isFinite(p.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length === 0) throw new Error(`No usable price points for ${ticker}`);
  return points;
}
