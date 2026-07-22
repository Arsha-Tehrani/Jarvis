import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { createCalendarEvent } from "@/lib/google";
import { queueSyncPush } from "@/lib/sync/client";
import { closeTaskEvent, type TaskRow } from "@/lib/tasks/calendar";
import { applyDeterministicRanks } from "@/lib/tasks/rank";
import { queueLlmRankRefresh } from "@/lib/tasks/rank-llm";
import { analyzeBulkImport } from "@/lib/bulk-import/parse";
import {
  commitBulkImport,
  discardBulkImport,
  finalSelectionSchema,
  undoBulkImport,
  type FinalTask,
} from "@/lib/bulk-import/commit";

// Bulk task-list import. `analyze` only parses and records a proposal —
// NOTHING is created until `commit` arrives with the user's edited selection
// from the preview (no silent auto-commit anywhere in this feature). The same
// analyze/commit core backs the Tasks-page panel and the bulk_import_tasks
// agent tool.

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("analyze"), text: z.string().min(1).max(100_000) }),
  z.object({
    action: z.literal("commit"),
    import_id: z.number().int().positive(),
    selection: finalSelectionSchema,
  }),
  z.object({ action: z.literal("discard"), import_id: z.number().int().positive() }),
  z.object({ action: z.literal("undo"), import_id: z.number().int().positive() }),
]);

// The panel's history/undo list. proposed_json is included only for the
// still-pending proposal (so an agent-initiated analyze can be reviewed here).
export async function GET() {
  const rows = getDb()
    .prepare(
      `SELECT id, created_at, source_mode, model_used, status, proposed_json, created_task_ids
       FROM bulk_imports ORDER BY id DESC LIMIT 10`
    )
    .all() as Array<{
    id: number;
    created_at: string;
    source_mode: string;
    model_used: string | null;
    status: string;
    proposed_json: string;
    created_task_ids: string | null;
  }>;
  return NextResponse.json({
    imports: rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      source_mode: r.source_mode,
      model_used: r.model_used,
      status: r.status,
      proposal: r.status === "proposed" ? JSON.parse(r.proposed_json) : undefined,
      task_count: r.created_task_ids ? (JSON.parse(r.created_task_ids) as number[]).length : null,
    })),
  });
}

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const body = parsed.data;
  const db = getDb();

  try {
    switch (body.action) {
      case "analyze": {
        const result = await analyzeBulkImport(body.text);
        return NextResponse.json({
          importId: result.importId,
          sourceMode: result.sourceMode,
          proposal: result.proposal,
        });
      }
      case "commit": {
        const { taskIds, reminders } = commitBulkImport(db, body.import_id, body.selection);
        applyDeterministicRanks(db);
        queueLlmRankRefresh();
        queueSyncPush();
        // Reminder-toggled items become calendar events via the same
        // createCalendarEvent path set_reminder uses — after the task
        // transaction, best-effort: a Google failure never unwinds the commit.
        const reminderResults = await createReminders(reminders);
        return NextResponse.json({ ok: true, created: taskIds.length, reminders: reminderResults });
      }
      case "discard": {
        discardBulkImport(db, body.import_id);
        return NextResponse.json({ ok: true });
      }
      case "undo": {
        const result = undoBulkImport(db, body.import_id);
        applyDeterministicRanks(db);
        queueSyncPush();
        // Close any mirror events already created for the removed tasks —
        // best-effort, same "calendar never fails a task write" rule.
        for (const taskId of result.removedTaskIds) {
          const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow;
          if (row?.gcal_event_id) {
            await closeTaskEvent(row, "deleted").catch((err) =>
              console.error("[bulk-import] mirror close failed:", err)
            );
          }
        }
        return NextResponse.json({ ok: true, removed: result.removed });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bulk import failed";
    console.error(`[bulk-import] ${body.action} failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function createReminders(
  reminders: FinalTask[]
): Promise<Array<{ title: string; ok: boolean; error?: string }>> {
  const results: Array<{ title: string; ok: boolean; error?: string }> = [];
  for (const r of reminders) {
    if (!r.due_at) {
      results.push({ title: r.title, ok: false, error: "no date to anchor the reminder to" });
      continue;
    }
    try {
      await createCalendarEvent({
        title: `⏰ ${r.title}`,
        start: r.due_at, // date-only → all-day event with Google's default reminders
        notes: r.notes ?? undefined,
      });
      results.push({ title: r.title, ok: true });
    } catch (err) {
      results.push({
        title: r.title,
        ok: false,
        error: err instanceof Error ? err.message : "calendar write failed",
      });
    }
  }
  return results;
}
