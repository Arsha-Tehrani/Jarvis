import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { allSnapshots } from "@/lib/networth";
import { getCachedQuote, getQuotes, type Quote } from "@/lib/stocks";
import { getStockChart } from "@/lib/stocks/history";
import {
  PORTFOLIO_RANGES,
  hasBreakdown,
  portfolioSeriesFor,
} from "@/lib/stocks/portfolio-history";
import {
  buildIntradaySeries,
  type IntradayBar,
  type IntradayHolding,
} from "@/lib/stocks/portfolio-intraday";

// Portfolio value over time for the Stocks page — the INVESTMENT ACCOUNT
// only (stocks vs. cash-equivalent), never the manual bank/checking/savings
// accounts_total (that blended view lives on the Net Worth page, exactly
// once). Reads the SAME daily net-worth snapshot rows the Net Worth page
// draws (no second snapshot mechanism) and windows them through the pure
// filter. Named /portfolio-history to avoid colliding with
// /api/stocks/history, which is the per-ticker EOD price-history endpoint.
//
// Rows predating the stocks/cash-equivalent split have null stocks_value/
// cash_equivalent_value and render as a gap rather than a fabricated $0;
// `total` for those legacy rows falls back to `holdings_value`, which was
// ALREADY investment-account-only before this split existed — never
// `s.total` (the blended net-worth figure), so bank data never leaks in even
// on the no-breakdown fallback path.
//
// range=1d is the one range NOT served from snapshots — see intradayResponse
// below and the header comment in lib/stocks/portfolio-intraday.ts.

const querySchema = z.object({
  range: z.enum(PORTFOLIO_RANGES).default("3m"),
});

type HoldingRow = {
  ticker: string;
  shares: number;
  cost_basis: number;
  is_cash_equivalent: number;
};

function liveHoldings(): HoldingRow[] {
  return getDb()
    .prepare(
      "SELECT ticker, shares, cost_basis, is_cash_equivalent FROM holdings WHERE deleted_at IS NULL ORDER BY ticker"
    )
    .all() as HoldingRow[];
}

// 1D: today's positions valued at intraday prices for the session. Nothing
// here is persisted — no networth_snapshots write, no new table. The only
// caching is history.ts's existing 15-minute per-(ticker, interval)
// stock_chart_cache, which is what keeps the Yahoo call count down.
async function intradayResponse() {
  const holdings: IntradayHolding[] = liveHoldings();
  // Cash-equivalents (SPAXX and friends) are deliberately never fetched
  // intraday: no meaningful intraday price, and Yahoo serves one stale NAV
  // bar for them (history-core.ts's isSparseIntraday). They get a flat line.
  const equities = holdings.filter((h) => !h.is_cash_equivalent);

  // Previous close comes from each ticker's own prior-session bar where the
  // superset has one (priorBarsByTicker below) — this quote-derived value
  // (price − change) is the FALLBACK for a ticker whose bars don't reach back
  // that far, and it still prices the cash-equivalents, so warm it either
  // way. The quote cache is IN-MEMORY (lib/stocks.ts), warmed by the 15-minute cron and at
  // launch — so on a freshly started server it is cold, and a cache-only
  // read would leave every prevClose null and silently fall back to COST
  // BASIS. That would put the chart's dashed "Prev close" line at cost basis
  // and turn the header's "day move" into lifetime P/L under the wrong
  // label. So warm it: getQuotes is cache-first and only fetches the misses,
  // which is one batched call well inside the free tier. A missing key or a
  // failed fetch is not fatal — fall through to whatever is cached.
  let quotes = new Map<string, Quote>();
  try {
    quotes = await getQuotes(holdings.map((h) => h.ticker.toUpperCase()));
  } catch (err) {
    console.warn(
      `[portfolio-history] 1d: quotes unavailable (${
        err instanceof Error ? err.message : err
      }) — previous close falls back to cost basis`
    );
  }

  const prevCloseByTicker: Record<string, number | null> = {};
  const cashPriceByTicker: Record<string, number | null> = {};
  for (const h of holdings) {
    const t = h.ticker.toUpperCase();
    const q = quotes.get(t) ?? getCachedQuote(t);
    prevCloseByTicker[t] = q ? q.price - q.change : null;
    if (h.is_cash_equivalent) cashPriceByTicker[t] = q?.price ?? null;
  }

  // One getStockChart per equity ticker, in parallel. A ticker that fails is
  // NOT fatal: it is simply absent from barsByTicker, and the pure builder
  // holds it at its previous close for the whole session while every other
  // ticker renders normally.
  const charts = await Promise.all(
    equities.map(async (h) => {
      const ticker = h.ticker.toUpperCase();
      try {
        const chart = await getStockChart(ticker, "1D");
        // superset = the unshaped 6-day 5m window the 1D plan already
        // fetched, which contains the PRIOR session's bars that `series`
        // (sessions: 1) trims away. The builder reads the prior session's
        // close out of it, so the baseline costs no extra Yahoo call.
        return {
          ticker,
          series: chart.series,
          superset: chart.superset,
          fallback: chart.fallback,
        };
      } catch (err) {
        console.warn(
          `[portfolio-history] 1d: ${ticker} intraday unavailable (${
            err instanceof Error ? err.message : err
          }) — holding at previous close`
        );
        return { ticker, series: null, superset: null, fallback: null };
      }
    })
  );

  const barsByTicker: Record<string, IntradayBar[]> = {};
  const priorBarsByTicker: Record<string, IntradayBar[]> = {};
  let intradayFallbackLabel: string | null = null;
  for (const c of charts) {
    if (c.series) barsByTicker[c.ticker] = c.series;
    if (c.superset) priorBarsByTicker[c.ticker] = c.superset;
    // getStockChart degraded this ticker to daily bars — surface its label
    // rather than silently drawing coarser data (the never-silent rule).
    if (c.fallback && !intradayFallbackLabel) intradayFallbackLabel = c.fallback;
  }

  const built = buildIntradaySeries({
    holdings,
    barsByTicker,
    prevCloseByTicker,
    cashPriceByTicker,
    priorBarsByTicker,
  });

  return NextResponse.json({
    range: "1d",
    granularity: "intraday",
    // Already chart-shaped points (t/date/stocks/cash/total/isolated), unlike
    // the snapshot ranges which serve raw rows for the client to shape.
    series: built.points,
    hasBreakdown: true,
    session: built.session,
    prevCloseTotal: built.prevCloseTotal,
    intradayFallbackLabel,
  });
}

export async function GET(req: NextRequest) {
  // Default (not reject) on an invalid range, matching the per-ticker history
  // route's tolerance for a bad query param.
  const parsed = querySchema.safeParse({
    range: req.nextUrl.searchParams.get("range") ?? undefined,
  });
  const range = parsed.success ? parsed.data.range : "3m";

  if (range === "1d") {
    try {
      return await intradayResponse();
    } catch (err) {
      console.error("[portfolio-history] 1d failed:", err);
      return NextResponse.json({ error: "Intraday history unavailable" }, { status: 503 });
    }
  }

  const rows = allSnapshots().map((s) => ({
    date: s.date,
    stocks_value: s.stocks_value,
    cash_equivalent_value: s.cash_equivalent_value,
    total: s.stocks_value != null && s.cash_equivalent_value != null
      ? s.stocks_value + s.cash_equivalent_value
      : s.holdings_value,
  }));
  // Resolution is picked from the window (daily, or weekly past ~13 months).
  const { series, granularity } = portfolioSeriesFor(rows, range);

  return NextResponse.json({
    range,
    granularity,
    series,
    hasBreakdown: hasBreakdown(series),
  });
}
