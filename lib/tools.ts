import { z } from "zod";
import { getDb } from "@/lib/db";
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

export const tools: Tool[] = [addTask as Tool, logGym as Tool, logLeetcode as Tool];

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
