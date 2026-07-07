import { NextRequest, NextResponse } from "next/server";
import { getHealthChecks } from "@/lib/status";
import { summarizeChecks } from "@/lib/status-core";
import { getSyncStatus } from "@/lib/sync/client";

// System status: which optional integrations are currently working.
// (/api/health was already taken by the sleep/weight metrics API.)
// Results are cached ~20s server-side; ?fresh=1 (the manual refresh
// button) bypasses the cache.

export async function GET(req: NextRequest) {
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const checks = await getHealthChecks(fresh);
  return NextResponse.json({
    checks,
    summary: summarizeChecks(checks),
    sync: getSyncStatus(),
  });
}
