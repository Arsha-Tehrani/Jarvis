import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { queueSyncPush } from "@/lib/sync/client";
import { checkTrackerDuplicate, listTrackers } from "@/lib/trackers";
import { deleteTracker } from "@/lib/tracker-delete";

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
    try {
      db.prepare("INSERT INTO habits (name, cadence, goal) VALUES (?, ?, ?)").run(
        body.name,
        body.cadence ?? "daily",
        body.goal ?? 1
      );
    } catch {
      return NextResponse.json(
        { error: `A tracker named "${body.name}" already exists` },
        { status: 409 }
      );
    }
    queueSyncPush(); // debounced, non-blocking; no-op unless SYNC_ROLE=client
    return NextResponse.json({ trackers: listTrackers() }, { status: 201 });
  }

  const exists = db.prepare("SELECT 1 FROM habits WHERE id = ?").get(body.habitId);
  if (!exists) return NextResponse.json({ error: "Tracker not found" }, { status: 404 });
  const date = body.date ?? new Date().toISOString().slice(0, 10);
  if (body.action === "log") {
    db.prepare("INSERT OR IGNORE INTO habit_logs (habit_id, date) VALUES (?, ?)").run(
      body.habitId,
      date
    );
  } else {
    db.prepare("DELETE FROM habit_logs WHERE habit_id = ? AND date = ?").run(body.habitId, date);
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
