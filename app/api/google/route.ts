import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
  buildAuthUrl,
  disconnectGoogle,
  isGoogleConfigured,
  isGoogleConnected,
  pollCalendar,
} from "@/lib/google";

const actionSchema = z.object({
  action: z.enum(["connect", "poll", "disconnect"]),
});

export async function GET() {
  const events = getDb()
    .prepare(
      `SELECT google_event_id, title, start, end, updated_at
       FROM calendar_cache ORDER BY start ASC`
    )
    .all();
  return NextResponse.json({
    configured: isGoogleConfigured(),
    connected: isGoogleConnected(),
    events,
  });
}

export async function POST(req: NextRequest) {
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Expected {"action":"connect"|"poll"|"disconnect"}' },
      { status: 400 }
    );
  }

  try {
    switch (parsed.data.action) {
      case "connect": {
        const state = crypto.randomBytes(16).toString("hex");
        const res = NextResponse.json({ authUrl: buildAuthUrl(state) });
        res.cookies.set("google_oauth_state", state, {
          httpOnly: true,
          sameSite: "lax",
          maxAge: 600,
          path: "/",
        });
        return res;
      }
      case "poll": {
        const count = await pollCalendar();
        return NextResponse.json({ ok: true, events: count });
      }
      case "disconnect": {
        disconnectGoogle();
        return NextResponse.json({ ok: true });
      }
    }
  } catch (err) {
    const status =
      err instanceof GoogleNotConfiguredError || err instanceof GoogleNotConnectedError
        ? 409
        : 502;
    const message = err instanceof Error ? err.message : "Google request failed";
    console.error("[google] action failed:", err);
    return NextResponse.json({ error: message }, { status });
  }
}
