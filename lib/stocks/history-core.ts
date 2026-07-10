// Pure pieces of click-to-chart history: no DB/network imports, so
// `node --test` can exercise them directly (mirrors lib/sync/core.ts's
// split — the pure engine here, the DB/network glue in history.ts).

export type PricePoint = { date: string; close: number };

// The whole caching decision in one place. EOD data doesn't change until
// market close regardless of when it was first cached today, so any
// same-calendar-day cache hit is safe to serve — there's no "staler than N
// minutes" concept here like the 15-minute quote cache; it's "already
// fetched today" or not. (The cache predates the Yahoo migration: the
// original reason was Alpha Vantage's 25-req/day free tier; with Yahoo the
// reason shifts to "don't hammer an unofficial endpoint and keep ticker
// clicks fast" — the mechanism is identical either way.)
export function shouldFetch(cachedDate: string | null, today: string): boolean {
  return cachedDate !== today;
}

// The subset of yahoo-finance2's chart() result this app reads. quotes[].date
// arrives as a JS Date (market-open timestamp); it may also be an ISO string
// if a result was serialized in between.
export type YahooChartQuote = {
  date: Date | string;
  close?: number | null;
  adjclose?: number | null;
};
export type YahooChartResult = { quotes?: YahooChartQuote[] };

// Turns one yahoo-finance2 chart() result into points or a clear thrown
// error — directly testable against fixture objects, never a live call
// (unofficial-API rule). Raw close is used (matching what the chart always
// showed); adjclose only fills in when close is missing for a day.
export function parseYahooChart(result: YahooChartResult, ticker: string): PricePoint[] {
  const points: PricePoint[] = (result.quotes ?? [])
    .map((q) => {
      // Note: Number(null) is 0 — a no-price day must become NaN (dropped
      // below), never a phantom $0 close.
      const raw = q.close ?? q.adjclose;
      return {
        date: (q.date instanceof Date ? q.date.toISOString() : String(q.date)).slice(0, 10),
        close: typeof raw === "number" ? raw : NaN,
      };
    })
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length === 0) {
    throw new Error(`No historical data for ${ticker} (unknown or delisted symbol?)`);
  }
  return points;
}
