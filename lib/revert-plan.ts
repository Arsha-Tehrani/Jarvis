// Pure mapper from an executed agent tool call to its inverse SQL.
// No db/network imports so `node --test` can exercise it directly.
//
// Only tools with a CLEAN inverse are revertible. Anything that overwrote
// prior state we can't recover (log_contact bumped last_contacted), touched
// an external system (calendar, notes on disk), or was read-only is refused
// with a reason instead of guessed at.
//
// Inverses on SYNCED tables (tasks, gym_logs, leetcode_stats, habit_logs)
// tombstone instead of hard-deleting — the removal must propagate to other
// devices like any write (lib/sync/tombstone.ts). Unsynced tables
// (nutrition_logs, health_logs) keep plain DELETEs.

export type RevertPlan = {
  sql: string;
  params: (string | number)[];
  // Shown to the user in the confirmation/result text.
  description: string;
  // Optional non-SQL follow-up the executor (lib/revert.ts) runs after the
  // inverse commits — kept as plain data so this module stays pure.
  after?: { kind: "reopen-task-event"; taskId: number };
};

type Planner = (args: Record<string, unknown>, fallbackDate: string) => RevertPlan;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`logged args are missing "${key}" — cannot build a safe inverse`);
  }
  return v;
}

function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`logged args are missing numeric "${key}" — cannot build a safe inverse`);
  }
  return v;
}

// Date args are optional on most tools; when omitted the handler used "today"
// at execution time, which is the log row's created_at date, not today-now.
function dateOf(args: Record<string, unknown>, fallbackDate: string): string {
  const v = args["date"];
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallbackDate;
}

// Tombstone-shaped inverse for a synced table: pure SQL (this module has no
// db import), same bookkeeping as lib/sync/tombstone.ts — setting
// sync_dirty/updated_at inline keeps the sync triggers out of the loop. The
// AND deleted_at IS NULL guard preserves the "nothing matched" error when
// the row was already removed by hand.
const SQLITE_NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
function tombstoneSql(table: string, where: string): string {
  return `UPDATE ${table} SET deleted_at = ${SQLITE_NOW}, sync_dirty = 1,
            updated_at = ${SQLITE_NOW}
          WHERE (${where}) AND deleted_at IS NULL`;
}

const PLANNERS: Record<string, Planner> = {
  add_task: (args) => {
    const title = str(args, "title");
    return {
      sql: tombstoneSql(
        "tasks",
        `id = (SELECT MAX(id) FROM tasks
               WHERE title = ? AND source = 'agent' AND deleted_at IS NULL)`
      ),
      params: [title],
      description: `delete the agent-added task "${title}"`,
    };
  },
  log_gym: (args, fallback) => {
    const date = dateOf(args, fallback);
    return {
      sql: tombstoneSql("gym_logs", "date = ?"),
      params: [date],
      description: `remove the gym log for ${date}`,
    };
  },
  log_leetcode: (args, fallback) => {
    const date = dateOf(args, fallback);
    return {
      sql: tombstoneSql("leetcode_stats", "date = ?"),
      params: [date],
      description: `remove the LeetCode entry for ${date}`,
    };
  },
  log_metric: (args, fallback) => {
    const kind = str(args, "kind");
    const date = dateOf(args, fallback);
    return {
      sql: "DELETE FROM health_logs WHERE date = ? AND kind = ?",
      params: [date, kind],
      description: `remove the ${kind} entry for ${date}`,
    };
  },
  log_habit: (args, fallback) => {
    const name = str(args, "name");
    const date = dateOf(args, fallback);
    return {
      sql: tombstoneSql(
        "habit_logs",
        `date = ? AND habit_id =
           (SELECT id FROM habits WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL)`
      ),
      params: [date, name],
      description: `un-check the habit "${name}" for ${date}`,
    };
  },
  log_meal: (args, fallback) => {
    const item = str(args, "item");
    const date = dateOf(args, fallback);
    return {
      sql: `DELETE FROM nutrition_logs WHERE id = (
              SELECT MAX(id) FROM nutrition_logs WHERE item = ? AND date = ?)`,
      params: [item, date],
      description: `remove the logged meal "${item}" (${date})`,
    };
  },
  add_application: (args) => {
    const company = str(args, "company");
    const role = str(args, "role");
    return {
      sql: tombstoneSql(
        "applications",
        `id = (SELECT MAX(id) FROM applications
               WHERE company = ? AND role = ? AND deleted_at IS NULL)`
      ),
      params: [company, role],
      description: `delete the tracked application ${company} — ${role}`,
    };
  },
  // Inverse of completing a task: clear completed_at (and the mirrored
  // status), then have the executor rename the calendar event back from
  // "✓ {title}" to "Task: {title}". The WHERE guard makes an already-open
  // task a zero-change no-op, which executeRevert reports as such.
  complete_task: (args) => {
    const taskId = num(args, "task_id");
    return {
      sql: `UPDATE tasks SET completed_at = NULL, status = 'open'
            WHERE id = ? AND completed_at IS NOT NULL`,
      params: [taskId],
      description: `reopen task #${taskId} (clear its completion)`,
      after: { kind: "reopen-task-event", taskId },
    };
  },
  add_to_reading_list: (args) => {
    const title = str(args, "title");
    return {
      sql: tombstoneSql(
        "reading",
        `id = (SELECT MAX(id) FROM reading WHERE title = ? AND deleted_at IS NULL)`
      ),
      params: [title],
      description: `remove "${title}" from the reading list`,
    };
  },
};

export const REVERTIBLE_TOOLS = Object.keys(PLANNERS);

// Refusal reasons for tools we deliberately don't invert.
const NOT_REVERTIBLE: Record<string, string> = {
  set_goal: "the previous goal value wasn't kept — set the goal again instead",
  append_note: "notes live on disk in your vault — edit the note directly",
  create_calendar_event:
    "Google Calendar is the source of truth — delete the event in Google Calendar",
  set_reminder:
    "reminders are Google Calendar events — delete the event in Google Calendar",
  log_contact: "the previous last-contacted date was overwritten and can't be restored",
  delete_habit:
    "a deleted manual habit's logged entries are gone with it — recreate the tracker and re-log instead",
  advance_application: "the previous stage was overwritten — move it back explicitly",
  update_task: "the previous field values were overwritten — edit the task back explicitly",
  query_finance: "read-only, nothing to revert",
  ask_textbook: "read-only, nothing to revert",
  revert_action: "a revert can't be reverted",
};

export function revertRefusalReason(tool: string): string {
  return NOT_REVERTIBLE[tool] ?? "no inverse operation is defined for this tool";
}

// fallbackDate: the agent_log row's created_at date (YYYY-MM-DD), used when
// the logged args relied on "today" defaults. Throws with a clear message on
// unrevertible tools or malformed logged args.
export function planRevert(
  tool: string,
  args: Record<string, unknown>,
  fallbackDate: string
): RevertPlan {
  const planner = PLANNERS[tool];
  if (!planner) {
    throw new Error(`"${tool}" can't be reverted: ${revertRefusalReason(tool)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fallbackDate)) {
    throw new Error(`invalid fallback date "${fallbackDate}"`);
  }
  return planner(args, fallbackDate);
}
