import type Database from "better-sqlite3";

// What a Yes/No press on the morning check-in actually DOES — db passed in,
// the completion logger injected, no "@/…" imports and no Slack types in the
// signature (the tracker-delete.ts / dividends-auto.ts pattern). That's what
// lets node --test drive it against an in-memory DB with no socket, no Slack
// API, and no mocking beyond the database.
//
// The Socket Mode handler (lib/slack/socket.ts) does nothing but decode a
// payload and call this.

export type CheckinAnswer = "yes" | "no";

export type TrackerHabit = { id: number; name: string; source: string | null };

export type TrackerResponseInput = {
  habitId: number;
  date: string; // the HISTORICAL day being answered for, never today
  response: CheckinAnswer;
};

export type TrackerResponseDeps = {
  db: Database.Database;
  // Logs a completion for the given habit on the given historical date and
  // returns the human result. Injected because the real one routes through
  // the registered agent tools (log_gym / log_leetcode / log_habit), which
  // reach for the process-wide DB handle themselves.
  logCompletion: (habit: TrackerHabit, date: string) => Promise<string>;
};

export type TrackerResponseResult = {
  habit: TrackerHabit;
  answer: CheckinAnswer;
  // One-line result for the Slack confirmation and the audit log. Blocks are
  // NOT built here — that's applyAnswerToBlocks in checkin-core.ts, which
  // needs the original message and is a presentation concern.
  confirmationText: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function findCheckinHabit(
  db: Database.Database,
  habitId: number
): TrackerHabit | undefined {
  return db
    .prepare("SELECT id, name, source FROM habits WHERE id = ? AND deleted_at IS NULL")
    .get(habitId) as TrackerHabit | undefined;
}

// Auditable like every other agent action (non-negotiable #5): which tracker,
// which date, which answer, when.
function logTurn(
  db: Database.Database,
  userText: string,
  tool: string,
  args: unknown,
  result: string
): void {
  db.prepare("INSERT INTO agent_log (user_text, tool_calls, result) VALUES (?, ?, ?)").run(
    userText,
    JSON.stringify({ executed: [{ name: tool, args }] }),
    result
  );
}

export async function handleTrackerResponse(
  deps: TrackerResponseDeps,
  input: TrackerResponseInput
): Promise<TrackerResponseResult> {
  const { db, logCompletion } = deps;
  const { habitId, date, response } = input;
  if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);

  const habit = findCheckinHabit(db, habitId);
  if (!habit) throw new Error(`Tracker ${habitId} not found`);

  if (response === "yes") {
    // Completion truth stays in the tracker's OWN table — a yes writes there,
    // never to tracker_misses, so there's exactly one place per tracker that
    // says "done".
    const result = await logCompletion(habit, date);
    logTurn(
      db,
      `[slack] check-in: yes — "${habit.name}" for ${date}`,
      habit.source === "gym_logs"
        ? "log_gym"
        : habit.source === "leetcode"
          ? "log_leetcode"
          : "log_habit",
      { name: habit.name, date },
      result
    );
    return { habit, answer: "yes", confirmationText: `✅ Logged "${habit.name}" for ${date}.` };
  }

  // A no is an EXPLICIT miss — distinct from "never answered". ON CONFLICT DO
  // NOTHING keeps a double-tap (or a Slack redelivery) idempotent.
  db.prepare(
    `INSERT INTO tracker_misses (habit_id, date, created_at) VALUES (?, ?, ?)
     ON CONFLICT(habit_id, date) DO NOTHING`
  ).run(habit.id, date, new Date().toISOString());
  const result = `Marked "${habit.name}" as missed on ${date}.`;
  logTurn(
    db,
    `[slack] check-in: no — "${habit.name}" for ${date}`,
    "mark_tracker_missed",
    { name: habit.name, date },
    result
  );
  return { habit, answer: "no", confirmationText: `🔴 ${result}` };
}
