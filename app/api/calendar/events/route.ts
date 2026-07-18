import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
  createCalendarEvent,
} from "@/lib/google";

// Deterministic event creation for the Calendar page's "+ Event" quick-add —
// a real Google Calendar event, triggered from a form instead of an LLM tool
// call. Calls the exact same createCalendarEvent() the agent's
// create_calendar_event/set_reminder tools use (lib/google.ts), so there is
// one Google-write implementation total. No /api/agent involved.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const dateTimeField = z
  .string()
  .min(1)
  .refine(
    (s) => DATE_ONLY.test(s) || !Number.isNaN(Date.parse(s)),
    "must be YYYY-MM-DD (all-day) or a parseable ISO datetime"
  );

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  start: dateTimeField,
  end: dateTimeField.optional(),
  description: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { title, start, end, description } = parsed.data;
  try {
    const eventId = await createCalendarEvent({ title, start, end, notes: description });
    return NextResponse.json({ ok: true, eventId }, { status: 201 });
  } catch (err) {
    // Same status mapping as /api/google: config/connection issues are a
    // recoverable 409 (the message already says "reconnect from the
    // Calendar tab"), anything else from the Google API is a 502.
    const status =
      err instanceof GoogleNotConfiguredError || err instanceof GoogleNotConnectedError
        ? 409
        : 502;
    const message = err instanceof Error ? err.message : "Event creation failed";
    console.error("[calendar-events] create failed:", err);
    return NextResponse.json({ error: message }, { status });
  }
}
