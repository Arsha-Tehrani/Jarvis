import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { allSnapshots } from "@/lib/networth";
import {
  PORTFOLIO_RANGES,
  filterPortfolioHistory,
  hasBreakdown,
} from "@/lib/stocks/portfolio-history";

// Portfolio value over time for the Stocks page. Reads the SAME daily
// net-worth snapshot rows the Net Worth page draws (no second snapshot
// mechanism) and windows them through the pure filter. Named
// /portfolio-history to avoid colliding with /api/stocks/history, which is
// the per-ticker EOD price-history endpoint.
//
// Each snapshot stores accounts_total (manual account balances) + holdings
// value separately; the chart plots them as "cash/account" and "holdings"
// lines. Rows predating the split have null holdings/cash and render as a gap
// rather than a fabricated $0.

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
    holdings_value: s.holdings_value,
    cash_value: s.accounts_total,
    total: s.total,
  }));
  const series = filterPortfolioHistory(rows, range);

  return NextResponse.json({
    range,
    series,
    hasBreakdown: hasBreakdown(series),
  });
}
