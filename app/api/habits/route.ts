import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { queueSyncPush } from "@/lib/sync/client";
import { tombstone, undelete } from "@/lib/sync/tombstone";
import { checkTrackerDuplicate, listTrackers } from "@/lib/trackers";
import { deleteTracker } from "@/lib/tracker-delete";
import { defaultCheckinEnabled } from "@/lib/slack/checkin-core";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().trim().min(1).max(100),
    cadence: z.enum(["daily", "weekly"]).optional(),
    goal: z.number().int().min(1).max(100).optional(),
    // Create anyway, skipping the duplicate suggestion (the user chose "create
    // a new one" after seeing it).
    force: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("log"),
    habitId: z.number().int().positive(),
    date: z.string().regex(DATE_RE).optional(),
  }),
  z.object({
    action: z.literal("unlog"),
    habitId: z.number().int().positive(),
    date: z.string().regex(DATE_RE).optional(),
  }),
]);

// Trackers are the single unified list (manual habits + sourced/former-Goals).
export async function GET() {
  return NextResponse.json({ trackers: listTrackers() });
}

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const db = getDb();
  const body = parsed.data;

  if (body.action === "create") {
    // Deterministic duplicate check against EVERY existing tracker (built-in
    // and manual). A suggestion, never a block: return it and let the user
    // decide, unless they already chose to force-create.
    if (!body.force) {
      const dup = checkTrackerDuplicate(body.name);
      if (dup) {
        return NextResponse.json({ suggestion: dup }, { status: 200 });
      }
    }
    // A live same-name tracker is a real conflict; a tombstoned one is
    // revived (same natural key — recreating it after a synced delete must
    // not duplicate).
    const sameName = db
      .prepare("SELECT id, deleted_at FROM habits WHERE name = ?")
      .get(body.name) as { id: number; deleted_at: string | null } | undefined;
    if (sameName && sameName.deleted_at === null) {
      return NextResponse.json(
        { error: `A tracker named "${body.name}" already exists` },
        { status: 409 }
      );
    }
    const cadence = body.cadence ?? "daily";
    // A brand-new tracker gets whatever its source/cadence implies — the same
    // rule the column migration backfilled with (lib/slack/checkin-core.ts),
    // so creating one after the migration behaves identically to one that
    // predates it. New trackers created here are always manual (source null).
    const checkin = defaultCheckinEnabled(null, cadence) ? 1 : 0;
    if (sameName) {
      undelete(db, "habits", "id = ?", [sameName.id]);
      db.prepare(
        "UPDATE habits SET cadence = ?, goal = ?, checkin_enabled = ? WHERE id = ?"
      ).run(cadence, body.goal ?? 1, checkin, sameName.id);
    } else {
      db.prepare(
        "INSERT INTO habits (name, cadence, goal, checkin_enabled) VALUES (?, ?, ?, ?)"
      ).run(body.name, cadence, body.goal ?? 1, checkin);
    }
    queueSyncPush(); // debounced, non-blocking; no-op unless SYNC_ROLE=client
    return NextResponse.json({ trackers: listTrackers() }, { status: 201 });
  }

  const habit = db
    .prepare("SELECT id, name FROM habits WHERE id = ? AND deleted_at IS NULL")
    .get(body.habitId) as { id: number; name: string } | undefined;
  if (!habit) return NextResponse.json({ error: "Tracker not found" }, { status: 404 });
  const today = new Date().toISOString().slice(0, 10);
  if (body.date && body.date > today) {
    return NextResponse.json({ error: "Can't log a future date" }, { status: 400 });
  }
  const date = body.date ?? today;
  let changes = 0;
  if (body.action === "log") {
    // Revive a tombstoned same-day row instead of inserting a duplicate;
    // the WHERE keeps a re-log of an already-live day a true no-op.
    changes = db
      .prepare(
        `INSERT INTO habit_logs (habit_id, date) VALUES (?, ?)
         ON CONFLICT(habit_id, date) DO UPDATE SET deleted_at = NULL
         WHERE habit_logs.deleted_at IS NOT NULL`
      )
      .run(body.habitId, date).changes;
  } else {
    changes = tombstone(db, "habit_logs", "habit_id = ? AND date = ?", [body.habitId, date]);
  }
  // Heatmap corrections (explicit date, actually changed something) are
  // logged so revert_action can undo them — same precedent as agent writes;
  // the plain today-toggle button (no date in the body) stays unlogged.
  if (body.date && changes > 0) {
    db.prepare("INSERT INTO agent_log (user_text, tool_calls, result) VALUES (?, ?, ?)").run(
      `[trackers] heatmap correction: ${body.action} "${habit.name}" for ${date}`,
      JSON.stringify({
        executed: [
          {
            name: body.action === "log" ? "log_habit" : "unlog_habit",
            args: { name: habit.name, date },
          },
        ],
      }),
      `${body.action === "log" ? "Logged" : "Un-logged"} "${habit.name}" for ${date}.`
    );
  }
  queueSyncPush();
  return NextResponse.json({ trackers: listTrackers() });
}

const patchSchema = z.object({
  id: z.number().int().positive(),
  checkinEnabled: z.boolean(),
});

// Per-tracker config updates. Today that's exactly one field: whether the
// morning Slack check-in nags about this tracker (same interaction pattern as
// the Sync Control Center's per-category toggles).
export async function PATCH(req: NextRequest) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const changes = getDb()
    .prepare("UPDATE habits SET checkin_enabled = ? WHERE id = ? AND deleted_at IS NULL")
    .run(parsed.data.checkinEnabled ? 1 : 0, parsed.data.id).changes;
  if (changes === 0) {
    return NextResponse.json({ error: "Tracker not found" }, { status: 404 });
  }
  queueSyncPush();
  return NextResponse.json({ trackers: listTrackers() });
}

// Deletion branches on manual vs sourced (lib/tracker-delete.ts): a manual
// habit's logs cascade with it; a sourced tracker's underlying feed
// (gym_logs, leetcode_stats, ...) is never touched. The UI's confirm dialog
// is the gate — its copy differs by kind for exactly that reason.
export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  try {
    const result = deleteTracker(getDb(), id);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json(
      { error: message },
      { status: message === "Tracker not found" ? 404 : 500 }
    );
  }
}
