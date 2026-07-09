import { NextRequest, NextResponse } from "next/server";
import { HistoryNotConfiguredError, getStockHistory } from "@/lib/stocks/history";

// Click-to-chart: GET ?ticker=XXX. Lazy, on-click only (never called for a
// whole holdings list at once) — see docs/stock-history-feasibility.md.
// "Not configured" is a normal, calm state (200, not an error status) since
// it's expected for anyone without an ALPHAVANTAGE_API_KEY; a real fetch
// failure (rate limit, premium-gated, unknown symbol) is 502, matching the
// other sidecar/external-API proxy routes in this app.

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker")?.trim();
  if (!ticker) {
    return NextResponse.json({ error: "Missing ?ticker=" }, { status: 400 });
  }
  try {
    const series = await getStockHistory(ticker);
    return NextResponse.json({ ticker: ticker.toUpperCase(), series });
  } catch (err) {
    if (err instanceof HistoryNotConfiguredError) {
      return NextResponse.json({ error: err.message, configured: false }, { status: 200 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load price history" },
      { status: 502 }
    );
  }
}
