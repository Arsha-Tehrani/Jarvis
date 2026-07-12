import { getDb } from "@/lib/db";
import { REVERTIBLE_TOOLS, planRevert } from "@/lib/revert-plan";
import { reopenTaskEvent, type TaskRow } from "@/lib/tasks/calendar";

// Undo: find the most recent executed tool call in agent_log that has a
// clean inverse (lib/revert-plan.ts) and hasn't been reverted yet, then run
// that inverse. The delete and the reverted_actions marker commit in one
// transaction, so a revert can never half-apply or double-apply.

type ExecutedEntry = { name?: unknown; args?: unknown };

export type RevertTarget = {
  logId: number;
  callIndex: number;
  tool: string;
  args: Record<string, unknown>;
  userText: string;
  fallbackDate: string; // the log row's created_at date
};

const SCAN_LIMIT = 100;

export function findRevertTarget(toolFilter?: string): RevertTarget | null {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, user_text, tool_calls, created_at FROM agent_log ORDER BY id DESC LIMIT ?"
    )
    .all(SCAN_LIMIT) as Array<{
    id: number;
    user_text: string;
    tool_calls: string | null;
    created_at: string;
  }>;
  const alreadyReverted = db
    .prepare("SELECT 1 FROM reverted_actions WHERE log_id = ? AND call_index = ?")
    .pluck();

  for (const row of rows) {
    if (!row.tool_calls) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.tool_calls);
    } catch {
      continue; // malformed log row — skip, never guess
    }
    const executed = (parsed as { executed?: unknown })?.executed;
    if (!Array.isArray(executed)) continue;

    // Newest call within the turn first.
    for (let i = executed.length - 1; i >= 0; i--) {
      const entry = executed[i] as ExecutedEntry;
      const name = typeof entry.name === "string" ? entry.name : "";
      if (!REVERTIBLE_TOOLS.includes(name)) continue;
      if (toolFilter && name !== toolFilter) continue;
      if (alreadyReverted.get(row.id, i)) continue;
      const args =
        entry.args && typeof entry.args === "object"
          ? (entry.args as Record<string, unknown>)
          : {};
      return {
        logId: row.id,
        callIndex: i,
        tool: name,
        args,
        userText: row.user_text,
        fallbackDate: row.created_at.slice(0, 10),
      };
    }
  }
  return null;
}

// Returns a human-readable result string; throws with a clear message when
// the inverse can't be built or matches nothing (e.g. already deleted by hand).
export function executeRevert(target: RevertTarget): string {
  const plan = planRevert(target.tool, target.args, target.fallbackDate);
  const db = getDb();
  const run = db.transaction(() => {
    const info = db.prepare(plan.sql).run(...plan.params);
    if (info.changes === 0) {
      throw new Error(
        `Nothing matched — the ${target.tool} action ("${plan.description}") may have already been removed by hand.`
      );
    }
    db.prepare(
      "INSERT INTO reverted_actions (log_id, call_index, tool) VALUES (?, ?, ?)"
    ).run(target.logId, target.callIndex, target.tool);
    return info.changes;
  });
  const changes = run();
  // Non-SQL follow-up (e.g. renaming a task's calendar event back after a
  // completion is undone) — fire-and-forget: the SQL inverse already
  // committed, and calendar state self-heals via the reconciler.
  if (plan.after?.kind === "reopen-task-event") {
    const row = db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(plan.after.taskId) as TaskRow | undefined;
    if (row) {
      void reopenTaskEvent(row).catch((err) =>
        console.error("[revert] calendar reopen failed:", err)
      );
    }
  }
  return `Reverted ${target.tool} (from "${truncate(target.userText, 80)}"): ${plan.description} — ${changes} row${changes === 1 ? "" : "s"} affected.`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
