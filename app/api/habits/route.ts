import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { queueSyncPush } from "@/lib/sync/client";
import { listHabits } from "@/lib/habits";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().trim().min(1).max(100),
    cadence: z.enum(["daily", "weekly"]).optional(),
    goal: z.number().int().min(1).max(100).optional(),
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

export async function GET() {
  return NextResponse.json({ habits: listHabits() });
}

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const db = getDb();
  const body = parsed.data;

  if (body.action === "create") {
    try {
      db.prepare("INSERT INTO habits (name, cadence, goal) VALUES (?, ?, ?)").run(
        body.name,
        body.cadence ?? "daily",
        body.goal ?? 1
      );
    } catch {
      return NextResponse.json(
        { error: `A habit named "${body.name}" already exists` },
        { status: 409 }
      );
    }
    queueSyncPush(); // debounced, non-blocking; no-op unless SYNC_ROLE=client
    return NextResponse.json({ habits: listHabits() }, { status: 201 });
  }

  const exists = db.prepare("SELECT 1 FROM habits WHERE id = ?").get(body.habitId);
  if (!exists) return NextResponse.json({ error: "Habit not found" }, { status: 404 });
  const date = body.date ?? new Date().toISOString().slice(0, 10);
  if (body.action === "log") {
    db.prepare("INSERT OR IGNORE INTO habit_logs (habit_id, date) VALUES (?, ?)").run(
      body.habitId,
      date
    );
  } else {
    db.prepare("DELETE FROM habit_logs WHERE habit_id = ? AND date = ?").run(
      body.habitId,
      date
    );
  }
  queueSyncPush();
  return NextResponse.json({ habits: listHabits() });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const info = getDb().prepare("DELETE FROM habits WHERE id = ?").run(id);
  if (info.changes === 0) return NextResponse.json({ error: "Habit not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
