import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
  deleteCalendarEvent,
  updateCalendarEvent,
} from "@/lib/google";

// Edit/delete for GENUINE Google events, the counterpart of the sibling
// route's create. Task-mirror events ("Task: {title}", tasks.gcal_event_id)
// never come through here — the Calendar page dispatches those clicks to the
// Tasks edit UI so the mirror can't desync from its task. Same body shape as
// POST /api/calendar/events, same 409-on-reconnect / 502-on-Google error
// mapping.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const dateTimeField = z
  .string()
  .min(1)
  .refine(
    (s) => DATE_ONLY.test(s) || !Number.isNaN(Date.parse(s)),
    "must be YYYY-MM-DD (all-day) or a parseable ISO datetime"
  );

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    start: dateTimeField.optional(),
    end: dateTimeField.optional(),
    description: z.string().max(2000).optional(),
  })
  .refine((f) => f.title !== undefined || f.start !== undefined || f.description !== undefined, {
    message: "Provide at least one of title, start, or description",
  })
  .refine((f) => f.end === undefined || f.start !== undefined, {
    message: "An end time requires a start time",
  });

type Params = { params: Promise<{ googleEventId: string }> };

function errorResponse(err: unknown, verb: string) {
  const status =
    err instanceof GoogleNotConfiguredError || err instanceof GoogleNotConnectedError
      ? 409
      : 502;
  const message = err instanceof Error ? err.message : `Event ${verb} failed`;
  console.error(`[calendar-events] ${verb} failed:`, err);
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { googleEventId } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { title, start, end, description } = parsed.data;
  try {
    await updateCalendarEvent(googleEventId, { title, start, end, notes: description });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "update");
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { googleEventId } = await params;
  try {
    await deleteCalendarEvent(googleEventId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "delete");
  }
}
