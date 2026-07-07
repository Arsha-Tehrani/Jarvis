// Pure mapper from an executed agent tool call to its inverse SQL.
// No db/network imports so `node --test` can exercise it directly.
//
// Only tools with a CLEAN inverse are revertible. Anything that overwrote
// prior state we can't recover (log_contact bumped last_contacted), touched
// an external system (calendar, notes on disk), or was read-only is refused
// with a reason instead of guessed at.

export type RevertPlan = {
  sql: string;
  params: (string | number)[];
  // Shown to the user in the confirmation/result text.
  description: string;
};

type Planner = (args: Record<string, unknown>, fallbackDate: string) => RevertPlan;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`logged args are missing "${key}" — cannot build a safe inverse`);
  }
  return v;
}

// Date args are optional on most tools; when omitted the handler used "today"
// at execution time, which is the log row's created_at date, not today-now.
function dateOf(args: Record<string, unknown>, fallbackDate: string): string {
  const v = args["date"];
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallbackDate;
}

const PLANNERS: Record<string, Planner> = {
  add_task: (args) => {
    const title = str(args, "title");
    return {
      sql: `DELETE FROM tasks WHERE id = (
              SELECT MAX(id) FROM tasks WHERE title = ? AND source = 'agent')`,
      params: [title],
      description: `delete the agent-added task "${title}"`,
    };
  },
  log_gym: (args, fallback) => {
    const date = dateOf(args, fallback);
    return {
      sql: "DELETE FROM gym_logs WHERE date = ?",
      params: [date],
      description: `remove the gym log for ${date}`,
    };
  },
  log_leetcode: (args, fallback) => {
    const date = dateOf(args, fallback);
    return {
      sql: "DELETE FROM leetcode_stats WHERE date = ?",
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
      sql: `DELETE FROM habit_logs WHERE date = ? AND habit_id =
              (SELECT id FROM habits WHERE LOWER(name) = LOWER(?))`,
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
      sql: `DELETE FROM applications WHERE id = (
              SELECT MAX(id) FROM applications WHERE company = ? AND role = ?)`,
      params: [company, role],
      description: `delete the tracked application ${company} — ${role}`,
    };
  },
  add_to_reading_list: (args) => {
    const title = str(args, "title");
    return {
      sql: `DELETE FROM reading WHERE id = (
              SELECT MAX(id) FROM reading WHERE title = ?)`,
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
  advance_application: "the previous stage was overwritten — move it back explicitly",
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
