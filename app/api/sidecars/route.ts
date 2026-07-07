import { NextResponse } from "next/server";
import { sidecarStatuses } from "@/lib/sidecars/manager";

// GET /api/sidecars — per-sidecar control state for the /status page:
// not-configured | stopped | starting | running | crashed, plus pid/uptime.

export async function GET() {
  return NextResponse.json({ sidecars: await sidecarStatuses() });
}
