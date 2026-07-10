import { NextRequest, NextResponse } from "next/server";
import { getStockHistory } from "@/lib/stocks/history";
import { isYahooError } from "@/lib/stocks/yahoo-client";

// Click-to-chart: GET ?ticker=XXX. Lazy, on-click only (never called for a
// whole holdings list at once) — see docs/stock-history-feasibility.md.
// History comes from yahoo-finance2 (no API key), so the old "not
// configured" state is gone; any fetch failure (HTTP error, unknown or
// delisted symbol) is 502 with a plain message, which the chart dialog
// renders as its calm degraded state — matching the other external-API
// proxy routes in this app.

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker")?.trim();
  if (!ticker) {
    return NextResponse.json({ error: "Missing ?ticker=" }, { status: 400 });
  }
  try {
    const series = await getStockHistory(ticker);
    return NextResponse.json({ ticker: ticker.toUpperCase(), series });
  } catch (err) {
    // Unofficial API — failure is normal. Name the library's error class in
    // the server log when it's one of yahoo-finance2's; degrade identically
    // either way.
    const message = err instanceof Error ? err.message : "Failed to load price history";
    console.error(
      `[stock-history] ${ticker}: ${isYahooError(err) ? `${(err as Error).name}: ` : ""}${message}`
    );
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
