import { NextResponse } from "next/server";
import { getTodayActivity } from "@/lib/activitywatch";

// Proxy for the dashboard <ScreenTime /> widget. ActivityWatch being
// offline is a normal state, so this always answers 200 with an
// availability flag rather than surfacing a 5xx to the client.

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getTodayActivity());
  } catch {
    return NextResponse.json({ available: false });
  }
}
