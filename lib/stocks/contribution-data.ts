import { getDb } from "@/lib/db";
import { getQuotes, trackedTickers, type Quote } from "@/lib/stocks";
import { computePortfolioTotal } from "@/lib/stocks/portfolio-total";
import { getStockChart } from "@/lib/stocks/history";
import {
  CONTRIBUTION_PERIODS,
  closeOnOrBefore,
  computeContribution,
  type ContributionPeriod,
  type ContributionResult,
  type HistoricalPrices,
} from "@/lib/stocks/contribution";

// Re-export so existing importers (the API route) keep one import site.
export { CONTRIBUTION_PERIODS, type ContributionPeriod };

// DB + network glue for per-holding contribution analysis. The pure math is in
// contribution.ts; this file values current holdings (via the shared
// computePortfolioTotal, same as /api/stocks) and fetches each holding's
// period-start close through the SAME audited Yahoo client + `stock_chart_cache`
// that click-to-chart already uses (getStockChart) — no second cache, no second
// client, no bypass of the once-per-ticker-per-calendar-day rate protection.

const PERIOD_DAYS: Record<ContributionPeriod, number> = { "1w": 7, "2w": 14, "1m": 30 };

// period → the YYYY-MM-DD we measure from: today minus the period's calendar
// days. We then take the closest trading-day close at or before it.
function periodStartTarget(period: ContributionPeriod, now: Date): string {
  return new Date(now.getTime() - PERIOD_DAYS[period] * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// One holding's period-start close, or null on any failure. A 3M daily chart
// comfortably covers both the 1w and 1m windows and reuses the shared 1d cache
// entry (getStockChart fetches a ~1-year daily superset keyed by ticker), so a
// ticker already charted today is a cache hit here too. A missing/failed
// ticker degrades to null ("no data") for just that ticker — it never blocks
// the rest of the response.
async function periodStartPrice(
  ticker: string,
  target: string,
  now: Date
): Promise<number | null> {
  try {
    const chart = await getStockChart(ticker, "3M", now);
    return closeOnOrBefore(chart.series, target);
  } catch {
    return null;
  }
}

export type ContributionData = ContributionResult & { period: ContributionPeriod };

// Full response for the API route and the agent tool: value current holdings,
// fetch each one's period-start close, and run the pure attribution.
export async function computeContributionData(
  period: ContributionPeriod,
  now: Date = new Date()
): Promise<ContributionData> {
  const db = getDb();
  const holdings = db
    .prepare(
      "SELECT ticker, shares, cost_basis FROM holdings WHERE deleted_at IS NULL ORDER BY ticker"
    )
    .all() as { ticker: string; shares: number; cost_basis: number }[];

  // Current valuation: same path /api/stocks uses. Quote failures fall back to
  // cost basis per holding (never a crash), so contribution still renders.
  let quotes: Map<string, Quote> = new Map();
  const tickers = trackedTickers();
  if (tickers.length > 0) {
    try {
      quotes = await getQuotes(tickers);
    } catch {
      // leave quotes empty → computePortfolioTotal falls back to cost basis
    }
  }
  const { holdings: priced } = computePortfolioTotal(holdings, (t) => quotes.get(t));

  // Period-start close per holding, sequential to stay gentle on the unofficial
  // Yahoo endpoint (each call is cached once per ticker per day anyway).
  const target = periodStartTarget(period, now);
  const historical: HistoricalPrices = {};
  for (const p of priced) {
    historical[p.ticker.toUpperCase()] = await periodStartPrice(p.ticker, target, now);
  }

  const inputs = priced.map((p) => ({
    ticker: p.ticker,
    shares: p.shares,
    currentValue: p.value,
  }));
  const result = computeContribution(inputs, historical);
  return { period, ...result };
}
