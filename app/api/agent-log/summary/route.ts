import { NextResponse } from "next/server";
import { countRecentAgentErrors } from "@/lib/agent/log";
import { getDb } from "@/lib/db";

// A cheap count of error turns in the last 24h so the UI can show a badge on
// the Log button without pulling any rows.

export async function GET() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return NextResponse.json({ errors24h: countRecentAgentErrors(getDb(), since) });
}
