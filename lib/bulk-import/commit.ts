// Commit / discard / undo for a bulk import. All functions take the db handle
// so tests can run them against an in-memory database (same pattern as
// lib/tracker-delete.ts). No LLM here — only the user's final edited
// selection, validated at the API boundary, ever reaches these writes.

import type { Database } from "better-sqlite3";
import { z } from "zod";
import { bulkGroupSchema, type BulkTask } from "./schema.ts";

// The preview's edited selection: proposal shape plus the per-task
// "create as calendar reminder instead" toggle. Tasks the user excluded in
// the preview simply aren't in this payload — they are never created.
export const finalTaskSchema = bulkGroupSchema.shape.tasks.element.extend({
  createAsReminder: z.boolean().default(false),
});
export const finalGroupSchema = bulkGroupSchema.extend({
  tasks: z.array(finalTaskSchema).min(1).max(100),
});
export const finalSelectionSchema = z.object({
  groups: z.array(finalGroupSchema).min(1).max(50),
});
export type FinalSelection = z.infer<typeof finalSelectionSchema>;
export type FinalTask = z.infer<typeof finalTaskSchema>;

export type ImportRow = {
  id: number;
  status: string;
  created_task_ids: string | null;
};

function getImport(db: Database, importId: number): ImportRow {
  const row = db
    .prepare("SELECT id, status, created_task_ids FROM bulk_imports WHERE id = ?")
    .get(importId) as ImportRow | undefined;
  if (!row) throw new Error(`Bulk import #${importId} not found`);
  return row;
}

// tasks.description gets the notes plus the depends-on flag (the flat tasks
// table has no formal dependency relationship — a clear note is the design,
// per spec).
export function taskDescription(task: BulkTask): string | null {
  const parts = [task.notes, task.dependsOnNote ? `After: ${task.dependsOnNote}` : null].filter(
    Boolean
  );
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export type CommitResult = {
  taskIds: number[];
  // Reminder-toggled items are NOT created as tasks; the caller (API route)
  // creates the calendar events after the transaction, best-effort.
  reminders: FinalTask[];
};

// All-or-nothing write of the user's edited selection, exactly like
// reanalyze_commit: one transaction, source='bulk_import', and the
// bulk_imports row flips to 'committed' with final_json + created_task_ids
// recorded in the same transaction.
export function commitBulkImport(
  db: Database,
  importId: number,
  selection: FinalSelection
): CommitResult {
  const row = getImport(db, importId);
  if (row.status !== "proposed") {
    throw new Error(`Bulk import #${importId} is already ${row.status} — analyze again to re-import.`);
  }

  const insert = db.prepare(
    `INSERT INTO tasks (title, description, due_at, priority, status, source)
     VALUES (?, ?, ?, ?, 'open', 'bulk_import')`
  );
  const run = db.transaction(() => {
    const taskIds: number[] = [];
    const reminders: FinalTask[] = [];
    for (const group of selection.groups) {
      for (const task of group.tasks) {
        if (task.createAsReminder) {
          reminders.push(task);
          continue;
        }
        const info = insert.run(
          task.title,
          taskDescription(task),
          task.due_at,
          task.priority ?? "high"
        );
        taskIds.push(Number(info.lastInsertRowid));
      }
    }
    db.prepare(
      `UPDATE bulk_imports SET status = 'committed', final_json = ?, created_task_ids = ?
       WHERE id = ?`
    ).run(JSON.stringify(selection), JSON.stringify(taskIds), importId);
    return { taskIds, reminders };
  });
  return run();
}

export function discardBulkImport(db: Database, importId: number): void {
  const row = getImport(db, importId);
  if (row.status !== "proposed") {
    throw new Error(`Bulk import #${importId} is already ${row.status}`);
  }
  db.prepare("UPDATE bulk_imports SET status = 'discarded' WHERE id = ?").run(importId);
}

export type UndoResult = {
  removed: number;
  // Ids of the rows actually tombstoned, so the caller can close their
  // calendar mirror events best-effort (calendar failures never fail the undo).
  removedTaskIds: number[];
};

// Bulk undo: tombstone exactly the tasks in created_task_ids — the same
// tombstone shape lib/revert-plan.ts uses, looped over the recorded list, in
// one transaction. Tasks the user already deleted by hand are skipped (the
// deleted_at guard), never an error.
export function undoBulkImport(db: Database, importId: number): UndoResult {
  const row = getImport(db, importId);
  if (row.status !== "committed") {
    throw new Error(`Bulk import #${importId} is ${row.status} — only a committed import can be undone.`);
  }
  const ids = z.array(z.number().int().positive()).parse(JSON.parse(row.created_task_ids ?? "[]"));

  const now = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const tombstone = db.prepare(
    `UPDATE tasks SET deleted_at = ${now}, sync_dirty = 1, updated_at = ${now}
     WHERE id = ? AND deleted_at IS NULL`
  );
  const run = db.transaction(() => {
    const removedTaskIds: number[] = [];
    for (const id of ids) {
      // Rows the user already deleted by hand are skipped (the deleted_at
      // guard), never an error.
      const info = tombstone.run(id);
      if (info.changes > 0) removedTaskIds.push(id);
    }
    db.prepare("UPDATE bulk_imports SET status = 'reverted' WHERE id = ?").run(importId);
    return { removed: removedTaskIds.length, removedTaskIds };
  });
  return run();
}
