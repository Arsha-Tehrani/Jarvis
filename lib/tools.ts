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

export const tools: Tool[] = [addTask as Tool];

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
