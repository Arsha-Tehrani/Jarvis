import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getStockChart } from "@/lib/stocks/history";
import { TIMEFRAMES } from "@/lib/stocks/history-core";
import { isYahooError } from "@/lib/stocks/yahoo-client";

// Click-to-chart: GET ?ticker=XXX&timeframe=3M. Lazy, on-click/tab-change
// only (never called for a whole holdings list at once) — see
// docs/stock-history-feasibility.md. History comes from yahoo-finance2 (no
// API key). Intraday timeframes degrade to labeled daily bars inside
// getStockChart; anything that still fails (HTTP error, unknown or delisted
// symbol) is 502 with a plain message, which the chart dialog renders as its
// calm degraded state — matching the other external-API proxy routes.

const querySchema = z.object({
  ticker: z.string().trim().min(1).max(12),
  timeframe: z.enum(TIMEFRAMES).default("3M"),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse({
    ticker: req.nextUrl.searchParams.get("ticker") ?? "",
    timeframe: req.nextUrl.searchParams.get("timeframe") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { ticker, timeframe } = parsed.data;
  try {
    const chart = await getStockChart(ticker, timeframe);
    return NextResponse.json({
      ticker: ticker.toUpperCase(),
      timeframe: chart.timeframe,
      interval: chart.interval,
      fallback: chart.fallback,
      series: chart.series,
    });
  } catch (err) {
    // Unofficial API — failure is normal. Name the library's error class in
    // the server log when it's one of yahoo-finance2's; degrade identically
    // either way.
    const message = err instanceof Error ? err.message : "Failed to load price history";
    console.error(
      `[stock-history] ${ticker} ${timeframe}: ${isYahooError(err) ? `${(err as Error).name}: ` : ""}${message}`
    );
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
