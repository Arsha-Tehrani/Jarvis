import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { queueSyncPush } from "@/lib/sync/client";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const logSchema = z.object({
  date: z.string().regex(DATE_RE, "date must be YYYY-MM-DD").optional(),
  notes: z.string().max(2000).optional(),
});

export async function GET() {
  // A year plus change — enough for a 53-week heatmap.
  const since = new Date(Date.now() - 370 * 86400_000).toISOString().slice(0, 10);
  const rows = getDb()
    .prepare("SELECT id, date, notes FROM gym_logs WHERE date >= ? ORDER BY date ASC")
    .all(since);
  return NextResponse.json({ logs: rows });
}

export async function POST(req: NextRequest) {
  const parsed = logSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO gym_logs (date, notes) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET notes = COALESCE(excluded.notes, notes)`
    )
    .run(date, parsed.data.notes ?? null);
  const log = getDb().prepare("SELECT id, date, notes FROM gym_logs WHERE date = ?").get(date);
  queueSyncPush(); // debounced, non-blocking; no-op unless SYNC_ROLE=client
  return NextResponse.json({ log }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const info = getDb().prepare("DELETE FROM gym_logs WHERE date = ?").run(date);
  if (info.changes === 0) {
    return NextResponse.json({ error: "No log on that date" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
