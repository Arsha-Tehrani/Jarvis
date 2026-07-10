import { NextResponse } from "next/server";

// The server's own clock — the same process running lib/cron.ts, so what
// this returns is what scheduled jobs and "today" defaults actually run
// against. The <SystemClock /> header widget displays THIS, not the
// browser's clock: on one laptop they're normally identical, but the whole
// point is to remove doubt when they're not (timezone or drift mismatch).

export const dynamic = "force-dynamic";

export async function GET() {
  const now = new Date();
  return NextResponse.json({
    now: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: -now.getTimezoneOffset(),
  });
}
