import { z } from "zod";
import { getDb, nowIso } from "@/lib/db";
import { chat } from "@/lib/llm";
import { isSlackConfigured, sendDm } from "@/lib/slack";
import { getTool } from "@/lib/tools";
import { stillDueToday } from "@/lib/tasks/complete";
import {
  formatAmbiguousReply,
  formatCompletionReply,
  formatCurrentDigestReply,
  formatDigestMessage,
  matchTitles,
  parseTaskReply,
  resolveDigestIndex,
  type DigestTask,
} from "@/lib/slack/task-replies";

// Slack task digests (midday 13:00, evening 19:00) + reply-to-complete.
// Reuses the ONE existing Slack client (lib/slack.ts sendDm / the events
// route's verified inbound) — no second client. All parsing decisions live
// in the pure lib/slack/task-replies.ts; completion writes go through the
// complete_task agent tool so every entry point shares one write path.

const TOP_N = 3;

// Rank ordering with the same fallback chain as lib/tasks/sort.ts.
const RANK_ORDER = `ORDER BY llm_rank IS NULL, llm_rank ASC,
  due_at IS NULL, due_at ASC, created_at ASC`;

function topOpenTasks(limit: number): DigestTask[] {
  return getDb()
    .prepare(
      `SELECT id, title, due_at FROM tasks WHERE status = 'open' ${RANK_ORDER} LIMIT ?`
    )
    .all(limit) as DigestTask[];
}

function openCount(): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'`).get() as {
      n: number;
    }
  ).n;
}

export type DigestSlot = "morning" | "midday" | "evening";

// Idempotency: one row per (date, slot), UNIQUE-guarded. A slot that
// already has a row today never re-sends — that's what makes the launch
// catch-up safe to fire at any hour.
export function digestAlreadySent(date: string, slot: DigestSlot): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM slack_task_digests WHERE date = ? AND slot = ?`)
    .get(date, slot);
}

export function recordDigest(date: string, slot: DigestSlot, taskIds: number[]): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO slack_task_digests (date, slot, task_ids, sent_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(date, slot, JSON.stringify(taskIds), nowIso());
}

// Shared by the midday/evening cron jobs. The hour gate keeps launch
// catch-up from firing a slot before its time of day.
async function sendTaskDigest(slot: "midday" | "evening", notBeforeHour: number): Promise<void> {
  if (!isSlackConfigured()) {
    console.log(`[task-digest] Slack not configured — skipping ${slot} digest`);
    return;
  }
  const now = new Date();
  if (now.getHours() < notBeforeHour) return; // catch-up ran early — real tick will send
  const today = now.toISOString().slice(0, 10);
  if (digestAlreadySent(today, slot)) return;

  const top = topOpenTasks(TOP_N);
  const message = formatDigestMessage(openCount(), top);
  if (!message) {
    console.log(`[task-digest] ${slot}: zero open tasks — nothing sent`);
    return;
  }
  await sendDm(message);
  recordDigest(today, slot, top.map((t) => t.id));
  console.log(`[task-digest] ${slot} digest sent (${top.length} tasks)`);
}

export async function middayTaskDigestJob(): Promise<void> {
  await sendTaskDigest("midday", 13);
}

export async function eveningTaskDigestJob(): Promise<void> {
  await sendTaskDigest("evening", 19);
}

// ---- inbound: reply-to-complete ------------------------------------------------

type DigestRow = { task_ids: string };

function latestDigestTaskIds(today: string): number[] | null {
  const row = getDb()
    .prepare(
      `SELECT task_ids FROM slack_task_digests WHERE date = ? ORDER BY sent_at DESC LIMIT 1`
    )
    .get(today) as DigestRow | undefined;
  if (!row) return null;
  try {
    const ids = JSON.parse(row.task_ids) as unknown;
    return Array.isArray(ids) && ids.every((n) => typeof n === "number") ? ids : null;
  } catch {
    return null;
  }
}

// Complete through the registered agent tool (validate-then-execute, same
// as the check-in's tool calls) and log the turn to agent_log so
// revert_action can undo a Slack completion like any agent action.
async function completeViaTool(taskId: number, sourceText: string): Promise<string> {
  const tool = getTool("complete_task");
  if (!tool) throw new Error("complete_task tool not registered");
  const parsed = tool.schema.safeParse({ task_id: taskId });
  if (!parsed.success) throw new Error(`Invalid args: ${z.prettifyError(parsed.error)}`);
  const result = await tool.handler(parsed.data);
  getDb()
    .prepare("INSERT INTO agent_log (user_text, tool_calls, result) VALUES (?, ?, ?)")
    .run(
      sourceText,
      JSON.stringify({ executed: [{ name: "complete_task", args: { task_id: taskId } }] }),
      result
    );
  return result;
}

async function completeAndReply(taskId: number, sourceText: string): Promise<string> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  let result: string;
  try {
    result = await completeViaTool(taskId, sourceText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(message)) {
      // Digest referenced a task that was deleted in the meantime.
      return formatCurrentDigestReply(
        "That task isn't around anymore — here's what's still open:",
        topOpenTasks(TOP_N)
      );
    }
    throw err;
  }
  // Idempotent no-op (already completed via the board or a duplicate reply).
  if (result.startsWith("Already marked done:")) return result;
  const title = result.replace(/^✓ Completed: /, "");
  return formatCompletionReply(title, stillDueToday(db, today));
}

// Task-completion parsing for inbound Slack DMs. Runs BEFORE the check-in /
// agent pipeline; returns null when the message isn't a completion so
// existing behavior doesn't regress.
export async function handleTaskReply(text: string): Promise<string | null> {
  const intent = parseTaskReply(text);
  if (intent?.kind === "by-number") {
    const today = new Date().toISOString().slice(0, 10);
    const ids = latestDigestTaskIds(today);
    const taskId = ids ? resolveDigestIndex(ids, intent.index) : null;
    if (taskId == null) {
      // No digest today or index out of range → re-show the current list.
      return formatCurrentDigestReply(
        "I couldn't match that number to today's digest — here's the current list:",
        topOpenTasks(TOP_N)
      );
    }
    return completeAndReply(taskId, text);
  }

  if (intent?.kind === "by-words") {
    const open = getDb()
      .prepare(`SELECT id, title FROM tasks WHERE status = 'open'`)
      .all() as Array<{ id: number; title: string }>;
    const match = matchTitles(intent.words, open);
    if (match.kind === "one") return completeAndReply(match.id, text);
    if (match.kind === "many") return formatAmbiguousReply(match.candidates);
    // Zero substring hits → one LLM attempt, then hand off unchanged.
    const llmId = await llmResolveTask(text, open);
    if (llmId != null) return completeAndReply(llmId, text);
    return null;
  }

  return null;
}

// LLM fallback: one chat() call asking which open task the message refers
// to. zod-validated against the REAL open ids; null or invalid → the
// message flows to the normal agent pipeline unchanged.
async function llmResolveTask(
  text: string,
  open: Array<{ id: number; title: string }>
): Promise<number | null> {
  if (open.length === 0) return null;
  try {
    const reply = await chat({
      messages: [
        {
          role: "system",
          content:
            'The user says they completed a task. Given their message and the open task list, reply ONLY with JSON {"task_id": <id>} for the task they mean, or {"task_id": null} if unclear or they don\'t mean a task at all.',
        },
        {
          role: "user",
          content: JSON.stringify({ message: text, open_tasks: open }),
        },
      ],
    });
    const match = reply.text?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = z
      .object({ task_id: z.number().int().nullable() })
      .safeParse(JSON.parse(match[0]));
    if (!parsed.success || parsed.data.task_id == null) return null;
    return open.some((t) => t.id === parsed.data.task_id) ? parsed.data.task_id : null;
  } catch {
    return null;
  }
}
