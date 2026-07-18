import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { queueSyncPush } from "@/lib/sync/client";
import { tombstone } from "@/lib/sync/tombstone";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const logSchema = z.object({
  date: z.string().regex(DATE_RE, "date must be YYYY-MM-DD").optional(),
  notes: z.string().max(2000).optional(),
});

export async function GET() {
  // A year plus change — enough for a 53-week heatmap.
  const since = new Date(Date.now() - 370 * 86400_000).toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(
      "SELECT id, date, notes FROM gym_logs WHERE date >= ? AND deleted_at IS NULL ORDER BY date ASC"
    )
    .all(since);
  return NextResponse.json({ logs: rows });
}

export async function POST(req: NextRequest) {
  const parsed = logSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (parsed.data.date && parsed.data.date > today) {
    return NextResponse.json({ error: "Can't log a future date" }, { status: 400 });
  }
  const date = parsed.data.date ?? today;
  const info = getDb()
    .prepare(
      `INSERT INTO gym_logs (date, notes) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET
         notes = COALESCE(excluded.notes, notes), deleted_at = NULL`
    )
    .run(date, parsed.data.notes ?? null);
  // Backdated heatmap corrections are undoable via revert_action (the plain
  // "I went today" button sends no date and stays unlogged).
  if (parsed.data.date && info.changes > 0) {
    getDb()
      .prepare("INSERT INTO agent_log (user_text, tool_calls, result) VALUES (?, ?, ?)")
      .run(
        `[trackers] heatmap correction: log gym for ${date}`,
        JSON.stringify({ executed: [{ name: "log_gym", args: { date } }] }),
        `Logged gym for ${date}.`
      );
  }
  const log = getDb()
    .prepare("SELECT id, date, notes FROM gym_logs WHERE date = ? AND deleted_at IS NULL")
    .get(date);
  queueSyncPush(); // debounced, non-blocking; no-op unless SYNC_ROLE=client
  return NextResponse.json({ log }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const changes = tombstone(getDb(), "gym_logs", "date = ?", [date]);
  if (changes === 0) {
    return NextResponse.json({ error: "No log on that date" }, { status: 404 });
  }
  getDb()
    .prepare("INSERT INTO agent_log (user_text, tool_calls, result) VALUES (?, ?, ?)")
    .run(
      `[trackers] heatmap correction: un-log gym for ${date}`,
      JSON.stringify({ executed: [{ name: "unlog_gym", args: { date } }] }),
      `Removed the gym log for ${date}.`
    );
  queueSyncPush();
  return NextResponse.json({ ok: true });
}
