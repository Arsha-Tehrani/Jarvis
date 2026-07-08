import { getDb } from "@/lib/db";
import { loggedFetch } from "@/lib/network-log";

// Quotes via Finnhub (preferred: 60 req/min free) or Alpha Vantage
// (fallback: ~25 req/day free). A 15-minute in-memory cache keeps us far
// inside both free tiers; the cron job re-warms it every 15 minutes and at
// launch. No key → clear error state in the UI, never a crash.

export type Quote = {
  ticker: string;
  price: number;
  change: number; // absolute day move
  changePercent: number;
  fetchedAt: string;
};

const CACHE_TTL_MS = 15 * 60 * 1000;

const globalForStocks = globalThis as unknown as {
  __jarvisQuoteCache?: Map<string, Quote>;
};

function cache(): Map<string, Quote> {
  if (!globalForStocks.__jarvisQuoteCache) {
    globalForStocks.__jarvisQuoteCache = new Map();
  }
  return globalForStocks.__jarvisQuoteCache;
}

export class StocksNotConfiguredError extends Error {
  constructor() {
    super("No market-data key — set FINNHUB_API_KEY (or ALPHAVANTAGE_API_KEY) in .env.local");
  }
}

export function isStocksConfigured(): boolean {
  return !!(process.env.FINNHUB_API_KEY || process.env.ALPHAVANTAGE_API_KEY);
}

// Cache-only read: safe for server components (no network on render).
export function getCachedQuote(ticker: string): Quote | undefined {
  const hit = cache().get(ticker.toUpperCase());
  if (!hit) return undefined;
  if (Date.now() - Date.parse(hit.fetchedAt) > CACHE_TTL_MS) return undefined;
  return hit;
}

export async function getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
  const result = new Map<string, Quote>();
  const misses: string[] = [];
  for (const raw of tickers) {
    const ticker = raw.toUpperCase();
    const hit = getCachedQuote(ticker);
    if (hit) result.set(ticker, hit);
    else misses.push(ticker);
  }
  if (misses.length === 0) return result;
  if (!isStocksConfigured()) throw new StocksNotConfiguredError();

  // Per-ticker resilience: one unknown symbol (e.g. the SPAXX money-market
  // core, which Finnhub 403s) must not blank out every other quote. Skip the
  // failed ticker — it falls back to cost basis downstream — and only throw if
  // EVERY fetch failed (a genuinely broken key or rate-limit), so a real
  // outage still surfaces instead of silently showing an all-cost-basis page.
  let firstError: unknown;
  for (const ticker of misses) {
    try {
      const quote = process.env.FINNHUB_API_KEY
        ? await fetchFinnhub(ticker)
        : await fetchAlphaVantage(ticker);
      cache().set(ticker, quote);
      result.set(ticker, quote);
    } catch (err) {
      firstError ??= err;
      console.warn(`[stocks] skipping ${ticker}:`, err instanceof Error ? err.message : err);
    }
  }
  // Nothing priced at all (no cache, every fetch failed) → surface the outage.
  if (result.size === 0 && firstError) throw firstError;
  return result;
}

async function fetchFinnhub(ticker: string): Promise<Quote> {
  const params = new URLSearchParams({
    symbol: ticker,
    token: process.env.FINNHUB_API_KEY as string,
  });
  const res = await loggedFetch(`https://finnhub.io/api/v1/quote?${params}`, undefined, {
    feature: "stocks-refresh",
    purpose: "fetch quote",
  });
  if (!res.ok) throw new Error(`Finnhub responded ${res.status} for ${ticker}`);
  const data = (await res.json()) as { c?: number; d?: number | null; dp?: number | null };
  if (!data.c) throw new Error(`No quote for ${ticker} (unknown symbol?)`);
  return {
    ticker,
    price: data.c,
    change: data.d ?? 0,
    changePercent: data.dp ?? 0,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchAlphaVantage(ticker: string): Promise<Quote> {
  const params = new URLSearchParams({
    function: "GLOBAL_QUOTE",
    symbol: ticker,
    apikey: process.env.ALPHAVANTAGE_API_KEY as string,
  });
  const res = await loggedFetch(`https://www.alphavantage.co/query?${params}`, undefined, {
    feature: "stocks-refresh",
    purpose: "fetch quote",
  });
  if (!res.ok) throw new Error(`Alpha Vantage responded ${res.status} for ${ticker}`);
  const data = (await res.json()) as {
    "Global Quote"?: Record<string, string>;
    Note?: string;
    Information?: string;
  };
  if (data.Note || data.Information) {
    throw new Error(`Alpha Vantage rate limit hit — try later (free tier is ~25 requests/day)`);
  }
  const q = data["Global Quote"];
  const price = Number(q?.["05. price"]);
  if (!q || !price) throw new Error(`No quote for ${ticker} (unknown symbol?)`);
  return {
    ticker,
    price,
    change: Number(q["09. change"] ?? 0),
    changePercent: Number((q["10. change percent"] ?? "0").replace("%", "")),
    fetchedAt: new Date().toISOString(),
  };
}

export function trackedTickers(): string[] {
  const db = getDb();
  const holdings = db.prepare("SELECT ticker FROM holdings").all() as { ticker: string }[];
  const watch = db.prepare("SELECT ticker FROM watchlist").all() as { ticker: string }[];
  return [...new Set([...holdings, ...watch].map((r) => r.ticker.toUpperCase()))];
}

// Cron job: refresh all tracked tickers every 15 min (+ launch catch-up).
export async function refreshStocksJob(): Promise<void> {
  if (!isStocksConfigured()) {
    console.log("[stocks] no market-data key set — skipping refresh");
    return;
  }
  const tickers = trackedTickers();
  if (tickers.length === 0) {
    console.log("[stocks] nothing to refresh (no holdings/watchlist)");
    return;
  }
  try {
    cache().clear(); // force fresh fetch
    await getQuotes(tickers);
    console.log(`[stocks] refreshed ${tickers.length} quotes`);
  } catch (err) {
    console.error("[stocks] refresh failed:", err);
  }
}
