import { z } from "zod";
import { getDb } from "@/lib/db";
import { GOAL_KINDS, upsertGoal } from "@/lib/finance/goals";
import { createCalendarEvent } from "@/lib/google";
import { STAGES, addApplication, advanceApplicationByCompany } from "@/lib/career";
import { logHabitByName } from "@/lib/habits";
import { HEALTH_KINDS, logMetric } from "@/lib/health";
import { READING_KINDS, addReadingItem } from "@/lib/reading";
import { appendNote } from "@/lib/notes";
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
  due: z
    .string()
    .optional()
    .describe(
      "Due date as ISO 8601 (YYYY-MM-DD or full datetime). Resolve relative dates like 'Friday' to a concrete date before calling."
    ),
  priority: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe("Task priority; omit for medium"),
});

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
        "INSERT INTO tasks (title, due_at, priority, status, source) VALUES (?, ?, ?, 'open', 'agent')"
      )
      .run(args.title, due, args.priority ?? "medium");
    return `Added task "${args.title}"${due ? ` due ${due}` : ""}.`;
  },
};

// Reject due dates the DB would store but the UI couldn't parse.
function normalizeDue(due: string | undefined): string | null {
  if (!due) return null;
  const parsed = new Date(due);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Unparseable due date: "${due}"`);
  }
  // Keep date-only strings as-is (no fake midnight timezone shifts).
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : parsed.toISOString();
}

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .optional()
  .describe("Date as YYYY-MM-DD; omit for today. Resolve relative dates yourself.");

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
         ON CONFLICT(date) DO UPDATE SET notes = COALESCE(excluded.notes, notes)`
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
        "SELECT total_solved, streak FROM leetcode_stats ORDER BY date DESC LIMIT 1"
      )
      .get() as { total_solved: number; streak: number } | undefined;
    const total = (previous?.total_solved ?? 0) + (args.count ?? 0);
    const recent = (args.problems ?? []).map((title) => ({
      title,
      titleSlug: "",
      timestamp: String(Math.floor(Date.now() / 1000)),
    }));
    const save = db.transaction(() => {
      db.prepare("DELETE FROM leetcode_stats WHERE date = ?").run(date);
      db.prepare(
        "INSERT INTO leetcode_stats (date, total_solved, streak, recent) VALUES (?, ?, ?, ?)"
      ).run(date, total, previous?.streak ?? 0, JSON.stringify(recent));
    });
    save();
    return `Logged LeetCode for ${date}${args.count ? ` (+${args.count}, total ${total})` : ""}.`;
  },
};

const setGoalSchema = z.object({
  kind: z
    .enum(GOAL_KINDS)
    .describe("Which goal to set: savings_rate (percent of income), gym_days_per_week, or leetcode_per_week"),
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

const addApplicationSchema = z.object({
  company: z.string().trim().min(1).max(200).describe("Company name"),
  role: z.string().trim().min(1).max(200).describe("Role / job title"),
  stage: z.enum(STAGES).optional().describe("Pipeline stage; omit for 'applied'"),
  next_action: z.string().max(500).optional().describe("What to do next, if known"),
  next_action_at: dateField,
  contact: z.string().max(200).optional().describe("Recruiter / referral contact"),
  link: z.string().max(1000).optional().describe("Job-posting URL"),
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

export const tools: Tool[] = [
  addTask as Tool,
  logGym as Tool,
  logLeetcode as Tool,
  setGoal as Tool,
  appendNoteTool as Tool,
  createEventTool as Tool,
  setReminderTool as Tool,
  logMetricTool as Tool,
  logHabitTool as Tool,
  addApplicationTool as Tool,
  advanceApplicationTool as Tool,
  addToReadingListTool as Tool,
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
