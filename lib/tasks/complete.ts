import type { DbLike } from "./rank";

// Pure core of task completion — the ONE write path every entry point
// (agent complete_task tool, Slack reply-to-complete, and anything future)
// funnels through, so the idempotency guarantee is universal:
//   - completed_at already set → successful no-op ('already-done'); callers
//     must NOT re-fire the calendar close or error.
//   - row missing → typed 'not-found' the caller turns into its own reply.
// Db passed in (lib/tracker-delete.ts pattern) so node --test covers it.

export type CompleteOutcome =
  | { outcome: "completed"; title: string }
  | { outcome: "already-done"; title: string }
  | { outcome: "not-found" };

export function completeTaskCore(
  db: DbLike,
  taskId: number,
  nowIso: () => string = () => new Date().toISOString()
): CompleteOutcome {
  const row = db
    .prepare(`SELECT id, title, completed_at FROM tasks WHERE id = ? AND deleted_at IS NULL`)
    .get(taskId) as { id: number; title: string; completed_at: string | null } | undefined;
  if (!row) return { outcome: "not-found" };
  if (row.completed_at) return { outcome: "already-done", title: row.title };
  db.prepare(`UPDATE tasks SET completed_at = ?, status = 'done' WHERE id = ?`).run(
    nowIso(),
    taskId
  );
  return { outcome: "completed", title: row.title };
}

// Open tasks still due today (or overdue) — the tail line of the Slack
// completion reply.
export function stillDueToday(db: DbLike, todayIso: string): string[] {
  const rows = db
    .prepare(
      `SELECT title FROM tasks
       WHERE status = 'open' AND due_at IS NOT NULL AND substr(due_at, 1, 10) <= ?
         AND deleted_at IS NULL
       ORDER BY due_at ASC`
    )
    .all(todayIso) as Array<{ title: string }>;
  return rows.map((r) => r.title);
}
