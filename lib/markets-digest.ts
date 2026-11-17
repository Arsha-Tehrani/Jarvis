import { getDb } from "@/lib/db";
import { dividendSummary } from "@/lib/dividends";
import { getSetting, setSetting } from "@/lib/settings";
import { configuredChannelId, postTo } from "@/lib/slack";
import { getQuotes, trackedTickers, type Quote } from "@/lib/stocks";
import { computePortfolioTotal } from "@/lib/stocks/portfolio-total";
import { computeContributionData } from "@/lib/stocks/contribution-data";
import { formatContributionAnswer } from "@/lib/stocks/contribution";
import {
  digestWindow,
  dividendsInWindow,
  formatMarketsDigest,
} from "@/lib/markets-digest-core";

// Markets digest → SLACK_MARKETS_CHANNEL_ID.
//   Weekday: the most recent trading day's portfolio move.
//   Weekend: the past week's move, from the SAME contribution engine with a
//            7-day lookback — the exact calculation behind the Stocks page's
//            "1W" toggle, just a different lookback passed in.
// Both include dividends confirmed or newly pending in the covered window.
//
// No new math anywhere in here: valuation comes from computePortfolioTotal
// (the Stocks page's day-move-vs-previous-close figure), attribution from
// computeContributionData + formatContributionAnswer, and dividend payouts
// from dividendSummary. This file only picks the window and composes.

const LAST_SENT_KEY = "markets_digest_last_sent"; // YYYY-MM-DD

export function marketsDigestAlreadySent(today: string): boolean {
  return getSetting(LAST_SENT_KEY) === today;
}

export async function buildMarketsDigest(now: Date = new Date()): Promise<string> {
  const window = digestWindow(now);

  // The rollup line: same engine, same CONCENTRATION_THRESHOLD sentence the
  // Stocks page card shows, with this window's lookback.
  let contribution: Awaited<ReturnType<typeof computeContributionData>> | null = null;
  try {
    contribution = await computeContributionData(window.lookback, now);
  } catch (err) {
    console.error("[markets-digest] contribution failed:", err);
  }
  const hasAttribution = !!contribution && contribution.holdings.some((h) => h.hasData);

  let dollarChange: number | null = null;
  let percentChange: number | null = null;

  if (window.kind === "day") {
    // Weekday headline reuses the live day-move figure rather than the
    // lookback math — it's the same number the Stocks page shows.
    const holdings = getDb()
      .prepare(
        "SELECT ticker, shares, cost_basis FROM holdings WHERE deleted_at IS NULL ORDER BY ticker"
      )
      .all() as { ticker: string; shares: number; cost_basis: number }[];
    let quotes: Map<string, Quote> = new Map();
    const tickers = trackedTickers();
    if (tickers.length > 0) {
      try {
        quotes = await getQuotes(tickers);
      } catch (err) {
        console.error("[markets-digest] quote fetch failed:", err);
      }
    }
    const total = computePortfolioTotal(holdings, (t) => quotes.get(t));
    // pricedBy 'none'/'cost-basis' means no live quote backed any holding, so
    // there is no day move to report — null, never a fabricated $0.
    if (total.pricedBy === "market" || total.pricedBy === "mixed") {
      dollarChange = total.totalDayMove;
      const previousValue = total.totalValue - total.totalDayMove;
      percentChange = previousValue !== 0 ? (total.totalDayMove / previousValue) * 100 : null;
    }
  } else if (hasAttribution && contribution) {
    dollarChange = contribution.totalPortfolioDollarChange;
    percentChange = contribution.totalPortfolioPercentChange;
  }

  const dividends = dividendsInWindow(dividendSummary().events, window);

  return formatMarketsDigest({
    window,
    dollarChange,
    percentChange,
    drivers:
      hasAttribution && contribution ? formatContributionAnswer(contribution) : null,
    dividends,
  });
}

// Cron job — catch-up-on-launch safe (idempotent per calendar day) and a clean
// no-op when SLACK_MARKETS_CHANNEL_ID is unset, consistent with how the rest
// of the app treats an unconfigured feature.
export async function marketsDigestJob(now: Date = new Date()): Promise<void> {
  if (!configuredChannelId("markets")) {
    console.log("[markets-digest] SLACK_MARKETS_CHANNEL_ID not set — skipping");
    return;
  }
  const today = now.toISOString().slice(0, 10);
  if (marketsDigestAlreadySent(today)) return;
  try {
    const message = await buildMarketsDigest(now);
    await postTo("markets", { text: message });
    setSetting(LAST_SENT_KEY, today);
    console.log("[markets-digest] sent");
  } catch (err) {
    console.error("[markets-digest] failed:", err);
  }
}
