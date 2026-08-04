import { z } from "zod";
import { getDb } from "@/lib/db";
import { GOAL_KINDS, upsertGoal } from "@/lib/finance/goals";
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from "@/lib/google";
import { STAGES, addApplication, advanceApplicationByCompany } from "@/lib/career";
import { applicationDateSchema } from "@/lib/career-dates";
import { CATEGORIES } from "@/lib/finance/categorize";
import { formatFinanceAnswer, runFinanceQuery } from "@/lib/finance/query";
import {
  CONTRIBUTION_PERIODS,
  computeContributionData,
} from "@/lib/stocks/contribution-data";
import { formatContributionAnswer } from "@/lib/stocks/contribution";
import { logHabitByName } from "@/lib/habits";
import { deleteTracker, findHabitByName } from "@/lib/tracker-delete";
import { HEALTH_KINDS, logMetric } from "@/lib/health";
import { logContactByName } from "@/lib/people";
import { READING_KINDS, addReadingItem } from "@/lib/reading";
import { appendNote } from "@/lib/notes";
import { addMeals } from "@/lib/nutrition";
import { REVERTIBLE_TOOLS } from "@/lib/revert-plan";
import { executeRevert, findRevertTarget } from "@/lib/revert";
import { applyDeterministicRanks } from "@/lib/tasks/rank";
import { queueLlmRankRefresh } from "@/lib/tasks/rank-llm";
import { completeTaskCore } from "@/lib/tasks/complete";
import {
  closeTaskEvent,
  updateTaskEvent,
  type TaskRow,
} from "@/lib/tasks/calendar";
import type { LlmToolDef } from "@/lib/llm";

// Tool registry. Every tool the agent can call is defined here with a zod
// schema. /api/agent validates returned args against the schema before the
// handler runs — an unvalidated call is never executed (non-negotiable #1).
// Tools that spend, delete, or write financial data set requiresConfirm=true
// and are returned to the user for confirmation instead of executing (#2).

export type Tool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  requiresConfirm: boolean;
  handler: (args: z.infer<S>) => string | Promise<string>;
};

const addTaskSchema = z.object({
  title: z.string().min(1).describe("Short imperative title of the task"),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe("Optional longer detail for the task, if the user gave any"),
  due: z
    .string()
    .optional()
    .describe(
      "Due date as ISO 8601 (YYYY-MM-DD or full datetime). Resolve relative dates like 'Friday' to a concrete date before calling. Omit this field entirely if no due date was mentioned — never pass placeholder text like 'none' or 'n/a'."
    ),
  // Canonical values are urgent/high/later; the legacy low/medium/high are
  // still accepted (and normalized below) so pre-redesign agent calls and
  // any cached model behavior keep working.
  priority: z
    .enum(["urgent", "high", "later", "low", "medium"])
    .optional()
    .describe("Task priority: urgent, high, or later; omit for high"),
});

// Legacy → canonical priority (same mapping as the DB migration).
function normalizePriority(p: string | undefined): "urgent" | "high" | "later" {
  if (p === "urgent" || p === "later") return p;
  if (p === "low") return "later";
  return "high"; // 'high', 'medium', or unspecified
}

const addTask: Tool<typeof addTaskSchema> = {
  name: "add_task",
  description:
    "Add a task to the user's task list. Use when the user asks to be reminded of, or to track, something they need to do.",
  schema: addTaskSchema,
  requiresConfirm: false,
  handler: (args) => {
    const due = normalizeDue(args.due);
    getDb()
      .prepare(
        "INSERT INTO tasks (title, description, due_at, priority, status, source) VALUES (?, ?, ?, ?, 'open', 'agent')"
      )
      .run(args.title, args.description ?? null, due, normalizePriority(args.priority));
    applyDeterministicRanks(getDb());
    queueLlmRankRefresh();
    return `Added task "${args.title}"${due ? ` due ${due}` : ""}.`;
  },
};

// Placeholder text a tool-calling model sometimes sends for an optional
// field instead of omitting it — treat these as "no due date" rather than
// failing the whole call.
const NO_DUE_DATE_PLACEHOLDERS = new Set([
  "none",
  "n/a",
  "na",
  "null",
  "tbd",
  "unspecified",
  "unknown",
]);

// Reject due dates the DB would store but the UI couldn't parse.
function normalizeDue(due: string | undefined): string | null {
  if (!due) return null;
  const trimmed = due.trim();
  if (trimmed === "" || NO_DUE_DATE_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Unparseable due date: "${due}"`);
  }
  // Keep date-only strings as-is (no fake midnight timezone shifts).
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : parsed.toISOString();
}

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .optional()
  .describe(
    "Date as YYYY-MM-DD; omit for today. Resolve relative dates yourself. Never pass placeholder text like 'none' or 'n/a' — omit the field instead."
  );

const logGymSchema = z.object({
  date: dateField,
  notes: z.string().max(2000).optional().describe("Optional workout notes"),
});

const logGym: Tool<typeof logGymSchema> = {
  name: "log_gym",
  description:
    "Log a gym visit / workout for a date (defaults to today). Use when the user says they went to the gym or worked out.",
  schema: logGymSchema,
  requiresConfirm: false,
  handler: (args) => {
    const date = args.date ?? new Date().toISOString().slice(0, 10);
    getDb()
      .prepare(
        `INSERT INTO gym_logs (date, notes) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET
           notes = COALESCE(excluded.notes, notes), deleted_at = NULL`
      )
      .run(date, args.notes ?? null);
    return `Logged gym for ${date}.`;
  },
};

const logLeetcodeSchema = z.object({
  date: dateField,
  count: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of problems solved today (added to the running total)"),
  problems: z
    .array(z.string())
    .optional()
    .describe("Names of the problems solved, if mentioned"),
});

const logLeetcode: Tool<typeof logLeetcodeSchema> = {
  name: "log_leetcode",
  description:
    "Manually log LeetCode progress for a date (defaults to today). Use when the user says they solved LeetCode problems.",
  schema: logLeetcodeSchema,
  requiresConfirm: false,
  handler: (args) => {
    const db = getDb();
    const date = args.date ?? new Date().toISOString().slice(0, 10);
    const previous = db
      .prepare(
        "SELECT total_solved, streak FROM leetcode_stats WHERE deleted_at IS NULL ORDER BY date DESC LIMIT 1"
      )
      .get() as { total_solved: number; streak: number } | undefined;
    const total = (previous?.total_solved ?? 0) + (args.count ?? 0);
    const recent = (args.problems ?? []).map((title) => ({
      title,
      titleSlug: "",
      timestamp: String(Math.floor(Date.now() / 1000)),
    }));
    // Replace-by-date as UPDATE-else-INSERT (same pattern as
    // lib/leetcode.ts saveLeetCodeStats): keeps sync identity, revives a
    // tombstoned date.
    const save = db.transaction(() => {
      const info = db
        .prepare(
          `UPDATE leetcode_stats SET total_solved = ?, streak = ?, recent = ?, deleted_at = NULL
           WHERE date = ?`
        )
        .run(total, previous?.streak ?? 0, JSON.stringify(recent), date);
      if (info.changes === 0) {
        db.prepare(
          "INSERT INTO leetcode_stats (date, total_solved, streak, recent) VALUES (?, ?, ?, ?)"
        ).run(date, total, previous?.streak ?? 0, JSON.stringify(recent));
      }
    });
    save();
    return `Logged LeetCode for ${date}${args.count ? ` (+${args.count}, total ${total})` : ""}.`;
  },
};

const setGoalSchema = z.object({
  kind: z
    .enum(GOAL_KINDS)
    .describe(
      "Which goal to set: savings_rate (percent of income), gym_days_per_week, leetcode_per_week, sleep_hours, or calories_per_day"
    ),
  target: z
    .number()
    .positive()
    .max(1_000_000)
    .describe("Target value: percent for savings_rate, count for the others"),
  period: z.enum(["week", "month"]).optional().describe("Measurement period; omit for the sensible default"),
});

// Writes financial data → requiresConfirm (non-negotiable #2). The agent
// route returns this as pending; it only runs after the user confirms.
const setGoal: Tool<typeof setGoalSchema> = {
  name: "set_goal",
  description:
    "Set or update a personal goal (savings rate, gym days per week, LeetCode problems per week). Requires user confirmation before it commits.",
  schema: setGoalSchema,
  requiresConfirm: true,
  handler: (args) => {
    upsertGoal(args.kind, args.target, args.period);
    return `Goal set: ${args.kind} → ${args.target}${args.kind === "savings_rate" ? "%" : ""}.`;
  },
};

const appendNoteSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Note path relative to the vault root, e.g. 'Projects/jarvis.md'. Omit to append to today's daily note."
    ),
  text: z.string().min(1).max(10_000).describe("Markdown text to append"),
});

// Additive only (never overwrites), so no confirm gate per the rules.
const appendNoteTool: Tool<typeof appendNoteSchema> = {
  name: "append_note",
  description:
    "Append markdown text to a note in the user's Obsidian vault (defaults to today's daily note). Use when the user asks to note something down.",
  schema: appendNoteSchema,
  requiresConfirm: false,
  handler: (args) => {
    const written = appendNote(args.path, args.text);
    return `Appended to note "${written}".`;
  },
};

const isoDatetime = (label: string) =>
  z
    .string()
    .min(1)
    .describe(`${label} as ISO 8601 datetime, e.g. 2026-07-10T15:00:00. Resolve relative times yourself.`);

const createEventSchema = z.object({
  title: z.string().min(1).max(300).describe("Event title"),
  start: isoDatetime("Start time"),
  end: isoDatetime("End time").optional().describe("End time; omit for one hour after start"),
  notes: z.string().max(2000).optional().describe("Optional event description"),
});

const createEventTool: Tool<typeof createEventSchema> = {
  name: "create_calendar_event",
  description:
    "Create an event on the user's Google Calendar. Use for meetings, appointments, or anything with a start time.",
  schema: createEventSchema,
  requiresConfirm: false,
  handler: async (args) => {
    await createCalendarEvent(args);
    return `Created event "${args.title}" at ${args.start}.`;
  },
};

const setReminderSchema = z.object({
  text: z.string().min(1).max(300).describe("What to remind the user about"),
  when: isoDatetime("Reminder time"),
});

// Implemented as a calendar event (free phone notifications via Google).
const setReminderTool: Tool<typeof setReminderSchema> = {
  name: "set_reminder",
  description:
    "Set a reminder for the user at a specific time. Creates a short Google Calendar event so their phone notifies them.",
  schema: setReminderSchema,
  requiresConfirm: false,
  handler: async (args) => {
    const startMs = Date.parse(args.when);
    if (Number.isNaN(startMs)) throw new Error(`Unparseable reminder time: "${args.when}"`);
    await createCalendarEvent({
      title: `⏰ ${args.text}`,
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + 15 * 60 * 1000).toISOString(),
    });
    return `Reminder set for ${args.when}: ${args.text}.`;
  },
};

// Resolve "my 3pm dentist thing" to a concrete cached Google event id.
// Task-mirror events are refused — editing/deleting the mirror directly would
// desync it from its task; the task tools (update_task, etc.) own those.
// Ambiguity is an error listing the matches, never a guess.
function findCachedEvent(titleContains: string, date?: string): { id: string; title: string; start: string } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT google_event_id AS id, title, start FROM calendar_cache
       WHERE title LIKE ? COLLATE NOCASE ${date ? "AND start LIKE ?" : ""}
       ORDER BY start LIMIT 10`
    )
    .all(...(date ? [`%${titleContains}%`, `${date}%`] : [`%${titleContains}%`])) as Array<{
    id: string;
    title: string;
    start: string;
  }>;
  if (rows.length === 0) {
    throw new Error(`No calendar event matching "${titleContains}"${date ? ` on ${date}` : ""} found.`);
  }
  if (rows.length > 1) {
    const list = rows.map((r) => `"${r.title}" (${r.start})`).join(", ");
    throw new Error(`Multiple events match "${titleContains}": ${list}. Be more specific.`);
  }
  const mirror = db
    .prepare("SELECT title FROM tasks WHERE gcal_event_id = ? AND deleted_at IS NULL")
    .get(rows[0].id) as { title: string } | undefined;
  if (mirror) {
    throw new Error(
      `"${rows[0].title}" mirrors the task "${mirror.title}" — edit or delete the task instead, and its calendar event follows.`
    );
  }
  return rows[0];
}

const editEventSchema = z.object({
  title_contains: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Part of the existing event's title, used to find it (case-insensitive)"),
  date: dateField,
  new_title: z.string().trim().min(1).max(300).optional().describe("New event title"),
  new_start: isoDatetime("New start time").optional(),
  new_end: isoDatetime("New end time").optional().describe("New end time; requires new_start"),
});

// Writes to an external system (Google) → confirm-gated like every other
// destructive/external-write tool. `date` narrows the title match.
const editEventTool: Tool<typeof editEventSchema> = {
  name: "edit_calendar_event",
  description:
    "Change the title and/or time of an existing Google Calendar event (not a task — use update_task for tasks). Finds the event by a fragment of its title, optionally narrowed to a date. Requires user confirmation.",
  schema: editEventSchema,
  requiresConfirm: true,
  handler: async (args) => {
    if (!args.new_title && !args.new_start) {
      throw new Error("Nothing to change — provide new_title and/or new_start");
    }
    const event = findCachedEvent(args.title_contains, args.date);
    await updateCalendarEvent(event.id, {
      title: args.new_title,
      start: args.new_start,
      end: args.new_end,
    });
    return `Updated event "${args.new_title ?? event.title}"${args.new_start ? ` → ${args.new_start}` : ""}.`;
  },
};

const deleteEventSchema = z.object({
  title_contains: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Part of the event's title, used to find it (case-insensitive)"),
  date: dateField,
});

const deleteEventTool: Tool<typeof deleteEventSchema> = {
  name: "delete_calendar_event",
  description:
    "Delete an event from the user's Google Calendar (not a task — tasks have their own delete). Finds the event by a fragment of its title, optionally narrowed to a date. Requires user confirmation and cannot be undone.",
  schema: deleteEventSchema,
  requiresConfirm: true,
  handler: async (args) => {
    const event = findCachedEvent(args.title_contains, args.date);
    await deleteCalendarEvent(event.id);
    return `Deleted event "${event.title}" (${event.start}).`;
  },
};

const logMetricSchema = z.object({
  kind: z
    .enum(HEALTH_KINDS)
    .describe(
      "Which metric: sleep_hours (hours slept), bedtime (decimal hour of day, 23.5 = 11:30pm), weight, or mood (1-5)"
    ),
  value: z.number().describe("The value in that metric's unit"),
  date: dateField,
  notes: z.string().max(2000).optional().describe("Optional context"),
});

const logMetricTool: Tool<typeof logMetricSchema> = {
  name: "log_metric",
  description:
    "Log a health metric (sleep hours, bedtime, weight, or mood 1-5) for a date (defaults to today). Use when the user reports sleep, weight, or how they feel.",
  schema: logMetricSchema,
  requiresConfirm: false,
  handler: (args) => {
    const date = logMetric(args.kind, args.value, args.date, args.notes);
    return `Logged ${args.kind} = ${args.value} for ${date}.`;
  },
};

const logHabitSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .describe("The habit's name as the user calls it (matched case-insensitively)"),
  date: dateField,
});

const logHabitTool: Tool<typeof logHabitSchema> = {
  name: "log_habit",
  description:
    "Mark a habit as done for a date (defaults to today). Use when the user says they did one of their tracked habits. Fails with the list of existing habits if the name doesn't match.",
  schema: logHabitSchema,
  requiresConfirm: false,
  handler: (args) => logHabitByName(args.name, args.date),
};

const deleteHabitSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("The tracker/habit's name (matched case-insensitively; fails with the known list)"),
});

// Deleting a manual habit cascades its logged entries — real data loss, so
// this is confirm-gated and deliberately NOT revertible via revert_action
// (the logs are gone; a fake/lossy inverse would be worse than refusing).
const deleteHabitTool: Tool<typeof deleteHabitSchema> = {
  name: "delete_habit",
  description:
    "Delete a tracker/habit by name. A manual habit is removed along with ALL its logged entries (irreversible); a sourced tracker (linked to gym/LeetCode/sleep/calories/savings data) only removes the tracker config — the underlying data stays. Use when the user wants to stop tracking something.",
  schema: deleteHabitSchema,
  requiresConfirm: true,
  handler: (args) => {
    const db = getDb();
    const habit = findHabitByName(db, args.name);
    const result = deleteTracker(db, habit.id);
    return result.kind === "manual"
      ? `Deleted "${result.name}" and its ${result.deletedLogs} logged entr${result.deletedLogs === 1 ? "y" : "ies"}.`
      : `Removed the "${result.name}" tracker. The underlying ${result.source} data is untouched — a new tracker can point at it again later.`;
  },
};

const addApplicationSchema = z.object({
  company: z.string().trim().min(1).max(200).describe("Company name"),
  role: z.string().trim().min(1).max(200).describe("Role / job title"),
  stage: z.enum(STAGES).optional().describe("Pipeline stage; omit for 'applied'"),
  next_action: z.string().max(500).optional().describe("What to do next, if known"),
  next_action_at: dateField,
  contact: z.string().max(200).optional().describe("Recruiter / referral contact"),
  link: z.string().max(1000).optional().describe("Job-posting URL"),
  date_applied: applicationDateSchema,
});

const addApplicationTool: Tool<typeof addApplicationSchema> = {
  name: "add_application",
  description:
    "Track a new job application (company + role, optional stage/next action). Use when the user says they applied somewhere or wants to track a role.",
  schema: addApplicationSchema,
  requiresConfirm: false,
  handler: (args) => {
    addApplication(args);
    return `Tracking ${args.company} — ${args.role} (${args.stage ?? "applied"}).`;
  },
};

const advanceApplicationSchema = z.object({
  company: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Company of the application to move (matched case-insensitively)"),
  stage: z.enum(STAGES).describe("New pipeline stage"),
  next_action: z.string().max(500).optional().describe("Updated next action"),
  next_action_at: dateField,
});

const advanceApplicationTool: Tool<typeof advanceApplicationSchema> = {
  name: "advance_application",
  description:
    "Move a tracked job application to a new stage (e.g. got an interview, got rejected). Use when the user reports progress on an application.",
  schema: advanceApplicationSchema,
  requiresConfirm: false,
  handler: (args) =>
    advanceApplicationByCompany(args.company, args.stage, args.next_action, args.next_action_at),
};

const addToReadingListSchema = z.object({
  title: z.string().trim().min(1).max(300).describe("Title of the book/article/course"),
  kind: z
    .enum(READING_KINDS)
    .optional()
    .describe("What it is; omit for 'book'"),
  author: z.string().max(200).optional().describe("Author, if mentioned"),
  link: z.string().max(1000).optional().describe("URL, if mentioned"),
  notes: z.string().max(5000).optional().describe("Why it was added / context"),
});

const addToReadingListTool: Tool<typeof addToReadingListSchema> = {
  name: "add_to_reading_list",
  description:
    "Add a book, article, course, paper, or video to the user's reading/learning list. Use when the user says they want to read/watch/learn something.",
  schema: addToReadingListSchema,
  requiresConfirm: false,
  handler: (args) => {
    addReadingItem(args);
    return `Added "${args.title}" to the reading list (${args.kind ?? "book"}).`;
  },
};

const logContactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The person's name (matched case-insensitively against the people list)"),
  date: dateField,
  notes: z.string().max(2000).optional().describe("What you talked about, if mentioned"),
});

const logContactTool: Tool<typeof logContactSchema> = {
  name: "log_contact",
  description:
    "Record that the user talked to / caught up with a person on their keep-in-touch list (defaults to today). Fails with the known-people list if the name doesn't match.",
  schema: logContactSchema,
  requiresConfirm: false,
  handler: (args) => logContactByName(args.name, args.date, args.notes),
};

const queryFinanceSchema = z.object({
  metric: z
    .enum(["spend", "income", "net"])
    .describe("What to total: spend (money out), income (money in), or net"),
  category: z
    .enum(CATEGORIES)
    .optional()
    .describe("Restrict to one category, e.g. Dining for food questions"),
  merchant_contains: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Restrict to merchants/descriptions containing this text"),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "must be YYYY-MM")
    .optional()
    .describe("One calendar month as YYYY-MM, e.g. 2026-06 for June"),
  start_date: dateField,
  end_date: dateField,
});

// Read-only: the model fills these args and a vetted parameterized query
// builder does the rest — it can never emit SQL (non-negotiable #1 spirit).
const queryFinanceTool: Tool<typeof queryFinanceSchema> = {
  name: "query_finance",
  description:
    "Answer questions about the user's transactions: how much was spent/earned, filtered by category, merchant text, a month (YYYY-MM), or a date range. Returns a total plus a small category breakdown. Read-only.",
  schema: queryFinanceSchema,
  requiresConfirm: false,
  handler: (args) => formatFinanceAnswer(args, runFinanceQuery(args)),
};

const queryStockContributionSchema = z.object({
  period: z
    .enum(CONTRIBUTION_PERIODS)
    .default("1w")
    .describe("Window to analyze: '1w' for the past week (default), '1m' for the past month"),
});

// Read-only, like query_finance: the same core the /api/stocks/contribution
// route runs, formatted as a plain answer. Historical prices come through the
// existing stock_chart_cache + audited Yahoo client, so this adds no new
// external-API surface. No confirm gate (read-only).
const queryStockContributionTool: Tool<typeof queryStockContributionSchema> = {
  name: "query_stock_contribution",
  description:
    "Answer 'which stocks moved my portfolio this week/month' — per-holding dollar and % contribution to the portfolio's move over the past week ('1w') or month ('1m'), and which few holdings drove most of it. Read-only.",
  schema: queryStockContributionSchema,
  requiresConfirm: false,
  handler: async (args) => formatContributionAnswer(await computeContributionData(args.period)),
};

const logMealSchema = z.object({
  item: z.string().trim().min(1).max(200).describe("What was eaten, e.g. 'chicken burrito'"),
  calories: z.number().int().min(0).max(10_000).describe("Estimated calories"),
  protein: z.number().int().min(0).max(1_000).describe("Protein in grams"),
  carbs: z.number().int().min(0).max(1_000).describe("Carbs in grams"),
  fat: z.number().int().min(0).max(1_000).describe("Fat in grams"),
  date: dateField,
});

// Same validated insert path the macro sidecar's /api/nutrition uses; the
// zod gate above is what stands between model output and the table.
const logMealTool: Tool<typeof logMealSchema> = {
  name: "log_meal",
  description:
    "Log a meal with its macros (calories, protein/carbs/fat in grams) for a date (defaults to today). Estimate sensible integer macros from the user's description if they don't give exact numbers.",
  schema: logMealSchema,
  requiresConfirm: false,
  handler: (args) => {
    const { date, ...entry } = args;
    addMeals({ entries: [entry], source: "text", date });
    return `Logged ${entry.item}: ${entry.calories} kcal (P${entry.protein}/C${entry.carbs}/F${entry.fat}).`;
  },
};

const askTextbookSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe("The math question to answer from the ingested textbooks"),
});

// Read-only proxy to the local textbook-RAG sidecar (sidecars/textbook-rag),
// which retrieves chunks from ChromaDB and explains via the local Ollama
// model. No confirm gate needed; errors surface as clear messages.
const askTextbookTool: Tool<typeof askTextbookSchema> = {
  name: "ask_textbook",
  description:
    "Answer a math question using the user's ingested textbooks (vector search over vector calculus / differential equations books, answer cites sections). Use for conceptual math questions like 'explain Green's theorem'. Read-only.",
  schema: askTextbookSchema,
  requiresConfirm: false,
  handler: async (args) => {
    const base = process.env.TEXTBOOK_RAG_URL ?? "http://localhost:8016";
    let res: Response;
    try {
      res = await fetch(`${base}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: args.question }),
      });
    } catch {
      throw new Error(
        `Textbook sidecar is not running at ${base}. Start it: sidecars/textbook-rag/.venv/Scripts/python -m rag.server`
      );
    }
    const data = (await res.json().catch(() => null)) as {
      answer?: string;
      sources?: Array<{ source: string; section: string }>;
      detail?: string;
    } | null;
    if (!res.ok || !data?.answer) {
      throw new Error(
        typeof data?.detail === "string"
          ? data.detail
          : `Textbook sidecar error (${res.status})`
      );
    }
    const cited = [
      ...new Set((data.sources ?? []).map((s) => `${s.source} — ${s.section}`)),
    ];
    return cited.length > 0
      ? `${data.answer}\n\nSources: ${cited.join("; ")}`
      : data.answer;
  },
};

const bulkImportSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      "The user's pasted task list / notes dump, verbatim — do not summarize or reword it"
    ),
});

// Analyze ONLY — no tasks are created here. The proposal lands in
// bulk_imports (status 'proposed') and the user reviews/edits/confirms it in
// the Tasks page's Bulk Import panel (the preview-then-confirm gate every
// write path of this feature must pass through). requiresConfirm=false is
// correct because analyzing writes nothing but the proposal log row.
const bulkImportTool: Tool<typeof bulkImportSchema> = {
  name: "bulk_import_tasks",
  description:
    "Parse a pasted list of many to-dos (a checklist, meeting notes, a task dump) into grouped, structured task proposals. Creates NOTHING directly — the user reviews and confirms the proposal on the Tasks page. Use when the user pastes a list and asks to add these as tasks.",
  schema: bulkImportSchema,
  requiresConfirm: false,
  handler: async (args) => {
    const { analyzeBulkImport } = await import("@/lib/bulk-import/parse");
    const result = await analyzeBulkImport(args.text);
    const taskCount = result.proposal.groups.reduce((n, g) => n + g.tasks.length, 0);
    return `Parsed ${taskCount} task(s) in ${result.proposal.groups.length} group(s) (${result.sourceMode} input). Nothing is created yet — review and confirm in Tasks → Bulk Import.`;
  },
};

const revertActionSchema = z.object({
  tool: z
    .enum(REVERTIBLE_TOOLS as [string, ...string[]])
    .optional()
    .describe(
      "Restrict the undo to this action type, e.g. 'add_task' if the user says 'remove that task'. Omit to undo the most recent revertible action."
    ),
});

// Undo: maps a logged action to its inverse SQL (lib/revert-plan.ts).
// Deletes data → requiresConfirm (non-negotiable #2). The target is resolved
// at execution time (after the user confirms) from agent_log, skipping
// actions already in reverted_actions so nothing is undone twice.
const revertActionTool: Tool<typeof revertActionSchema> = {
  name: "revert_action",
  description:
    "Undo the most recent agent action (added task, logged gym/LeetCode/metric/habit/meal, tracked application, reading-list add). Use when the user says 'undo that', 'I didn't mean that', or 'remove what you just added'. Requires user confirmation.",
  schema: revertActionSchema,
  requiresConfirm: true,
  handler: (args) => {
    const target = findRevertTarget(args.tool);
    if (!target) {
      throw new Error(
        args.tool
          ? `No recent un-reverted ${args.tool} action found in the log.`
          : "No recent revertible action found in the log."
      );
    }
    return executeRevert(target);
  },
};

const completeTaskSchema = z.object({
  task_id: z.number().int().positive().describe("The id of the task to mark done"),
});

// Cleanly invertible (revert clears completed_at and renames the calendar
// event back), so no confirmation. Idempotency lives in completeTaskCore —
// the single write path every completion entry point (agent, Slack reply)
// funnels through: an already-done task is a successful no-op that does NOT
// re-fire the calendar close, and a missing id is a typed not-found.
const completeTaskTool: Tool<typeof completeTaskSchema> = {
  name: "complete_task",
  description:
    "Mark a task done by its id. Use when the user says they finished or completed a task.",
  schema: completeTaskSchema,
  requiresConfirm: false,
  handler: async (args) => {
    const result = completeTaskCore(getDb(), args.task_id);
    if (result.outcome === "not-found") {
      throw new Error(`Task ${args.task_id} not found`);
    }
    if (result.outcome === "already-done") {
      return `Already marked done: ${result.title}`;
    }
    const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(args.task_id) as TaskRow;
    await closeTaskEvent(row, "completed").catch((err) =>
      console.error(`[tools] complete_task calendar close failed:`, err)
    );
    applyDeterministicRanks(getDb());
    queueLlmRankRefresh();
    return `✓ Completed: ${result.title}`;
  },
};

const updateTaskSchema = z.object({
  task_id: z.number().int().positive().describe("The id of the task to update"),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  due_at: z
    .string()
    .optional()
    .describe("New due date, ISO 8601; resolve relative dates before calling"),
  priority: z.enum(["urgent", "high", "later"]).optional(),
});

const updateTaskTool: Tool<typeof updateTaskSchema> = {
  name: "update_task",
  description:
    "Update a task's title, description, due date, or priority by its id. Use when the user asks to change or reschedule an existing task.",
  schema: updateTaskSchema,
  requiresConfirm: false,
  handler: async (args) => {
    const { task_id, ...fields } = args;
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) throw new Error("Nothing to update — provide at least one field");
    const db = getDb();
    const setClause = entries.map(([k]) => `${k} = ?`).join(", ");
    const info = db
      .prepare(`UPDATE tasks SET ${setClause} WHERE id = ? AND deleted_at IS NULL`)
      .run(...entries.map(([, v]) => v), task_id);
    if (info.changes === 0) throw new Error(`Task ${task_id} not found`);
    // Same calendar path as the API route: mirror title/due changes onto the
    // linked event; failures logged, never surfaced as a task-write failure.
    if (fields.title !== undefined || fields.due_at !== undefined) {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as TaskRow;
      await updateTaskEvent(row).catch((err) =>
        console.error(`[tools] update_task calendar update failed:`, err)
      );
    }
    applyDeterministicRanks(db);
    queueLlmRankRefresh();
    const changed = entries.map(([k, v]) => `${k} → ${v}`).join(", ");
    const title = (db.prepare("SELECT title FROM tasks WHERE id = ?").get(task_id) as { title: string }).title;
    return `Updated "${title}": ${changed}.`;
  },
};

export const tools: Tool[] = [
  addTask as Tool,
  completeTaskTool as Tool,
  updateTaskTool as Tool,
  logGym as Tool,
  logLeetcode as Tool,
  setGoal as Tool,
  appendNoteTool as Tool,
  createEventTool as Tool,
  editEventTool as Tool,
  deleteEventTool as Tool,
  setReminderTool as Tool,
  logMetricTool as Tool,
  logHabitTool as Tool,
  deleteHabitTool as Tool,
  addApplicationTool as Tool,
  advanceApplicationTool as Tool,
  addToReadingListTool as Tool,
  logContactTool as Tool,
  queryFinanceTool as Tool,
  queryStockContributionTool as Tool,
  askTextbookTool as Tool,
  logMealTool as Tool,
  bulkImportTool as Tool,
  revertActionTool as Tool,
];

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

export function toolDefsForLlm(): LlmToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.schema,
  }));
}
