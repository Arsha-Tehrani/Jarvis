import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { allSnapshots } from "@/lib/networth";
import {
  PORTFOLIO_RANGES,
  hasBreakdown,
  portfolioSeriesFor,
} from "@/lib/stocks/portfolio-history";

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

const querySchema = z.object({
  range: z.enum(PORTFOLIO_RANGES).default("3m"),
});

export async function GET(req: NextRequest) {
  // Default (not reject) on an invalid range, matching the per-ticker history
  // route's tolerance for a bad query param.
  const parsed = querySchema.safeParse({
    range: req.nextUrl.searchParams.get("range") ?? undefined,
  });
  const range = parsed.success ? parsed.data.range : "3m";

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
