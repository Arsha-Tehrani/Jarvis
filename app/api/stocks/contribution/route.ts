import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  CONTRIBUTION_PERIODS,
  computeContributionData,
} from "@/lib/stocks/contribution-data";

// "What's driving your portfolio" — per-holding contribution over 1w/1m.
// Read-only, no LLM. zod-validates the period (default 1w). Historical closes
// come through the existing stock_chart_cache + audited Yahoo client, so this
// adds no new external-API surface beyond click-to-chart.

const querySchema = z.object({
  period: z.enum(CONTRIBUTION_PERIODS).default("1w"),
});

export async function GET(req: NextRequest) {
  // Default (not reject) on a bad period, matching the other stocks routes.
  const parsed = querySchema.safeParse({
    period: req.nextUrl.searchParams.get("period") ?? undefined,
  });
  const period = parsed.success ? parsed.data.period : "1w";

  try {
    const data = await computeContributionData(period);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute contribution";
    console.error("[stocks-contribution]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
