import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { queueSyncPush } from "@/lib/sync/client";
import {
  reopenTaskEvent,
  syncTaskWrite,
  type TaskRow,
} from "@/lib/tasks/calendar";
import { applyDeterministicRanks } from "@/lib/tasks/rank";
import { queueLlmRankRefresh } from "@/lib/tasks/rank-llm";

// Every task write re-ranks synchronously (deterministic, always works)
// and queues the debounced LLM refinement (advisory, never blocks).
function reRank(): void {
  applyDeterministicRanks(getDb());
  queueLlmRankRefresh();
}

// Priorities are the canonical board columns. Sync bookkeeping needs no
// explicit writes here: the sync triggers (lib/sync/tables.ts) mark rows
// dirty on every INSERT/UPDATE, and queueSyncPush() debounces the push —
// the same pattern every synced table's write path uses.

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  due_at: z.string().nullable().optional(),
  priority: z.enum(["urgent", "high", "later"]),
  // Provenance tag, free-text like the column (no CHECK constraint). Callers
  // that omit it keep the default 'manual' (the Tasks-page add form); the
  // Calendar page's quick-add sends 'calendar' so those rows stay
  // distinguishable in the data.
  source: z.string().min(1).max(50).optional(),
});

const updateSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  due_at: z.string().nullable().optional(),
  priority: z.enum(["urgent", "high", "later"]).optional(),
  status: z.enum(["open", "done"]).optional(),
  completed: z.boolean().optional(),
  // Set by the Apply/Dismiss buttons on a card's suggestion line.
  clear_suggestion: z.boolean().optional(),
});

export async function GET() {
  const rows = getDb()
    .prepare(
      `SELECT id, title, description, due_at, priority, status, source, created_at,
              gcal_event_id, completed_at, llm_rank, llm_rank_source,
              llm_suggested_priority, llm_rationale
       FROM tasks
       ORDER BY status ASC, due_at IS NULL, due_at ASC, created_at DESC`
    )
    .all();
  return NextResponse.json({ tasks: rows });
}

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { title, description, due_at, priority, source } = parsed.data;
  const info = getDb()
    .prepare(
      "INSERT INTO tasks (title, description, due_at, priority, status, source) VALUES (?, ?, ?, ?, 'open', ?)"
    )
    .run(title, description ?? null, due_at ?? null, priority, source ?? "manual");
  // Calendar event in the same request (a failure never fails the write —
  // the hourly reconciler retries anything left unlinked).
  const inserted = getDb()
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(info.lastInsertRowid) as TaskRow;
  await syncTaskWrite("create", inserted);
  reRank();
  const task = getDb()
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(info.lastInsertRowid);
  queueSyncPush(); // debounced, non-blocking; no-op unless SYNC_ROLE=client
  return NextResponse.json({ task }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { id, completed, clear_suggestion, ...fields } = parsed.data;
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  // `completed` drives both the timestamp and the legacy status column so
  // the two can never disagree.
  if (completed !== undefined) {
    entries.push(["completed_at", completed ? new Date().toISOString() : null]);
    entries.push(["status", completed ? "done" : "open"]);
  }
  if (clear_suggestion) {
    entries.push(["llm_suggested_priority", null]);
    entries.push(["llm_rationale", null]);
  }
  if (entries.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  const setClause = entries.map(([k]) => `${k} = ?`).join(", ");
  const info = getDb()
    .prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`)
    .run(...entries.map(([, v]) => v as string | null), id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const updated = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
  // Mirror the write onto the linked calendar event (failures logged, never
  // surfaced as a task-write failure).
  if (completed === true) {
    await syncTaskWrite("complete", updated);
  } else if (completed === false) {
    await reopenTaskEvent(updated).catch(() => {});
  } else if (fields.title !== undefined || fields.due_at !== undefined) {
    await syncTaskWrite("update", updated);
  }
  reRank();
  const task = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  queueSyncPush();
  return NextResponse.json({ task });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  // Read the row before it goes so the linked calendar event can be removed
  // (404 from Google is fine — the event may already be hand-deleted).
  const existing = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | TaskRow
    | undefined;
  if (!existing) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  await syncTaskWrite("delete", existing);
  getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
  reRank(); // remaining tasks close the gap
  return NextResponse.json({ ok: true });
}
