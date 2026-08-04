// Pure half of Slack reply-to-complete: parsing "done 2" / "finished the
// recruiter email" style messages, resolving them against the digest that
// was actually displayed, and formatting every reply the DM sends back.
// No db/network imports — node --test exercises all of it directly. The
// glue (db lookups, sendDm, the LLM fallback) lives in
// lib/slack/task-digest.ts.

export type TaskReplyIntent =
  | { kind: "by-number"; index: number } // 1-based, as displayed
  | { kind: "by-words"; words: string };

// Deterministic parse — runs BEFORE any LLM fallback. Returns null for
// anything that isn't clearly a completion message, so check-in answers
// ("yes", "7h", "no gym") fall through to the existing pipeline untouched.
export function parseTaskReply(text: string): TaskReplyIntent | null {
  const t = text.trim();
  let m = /^(?:done|finished|completed?)\s+#?(\d{1,3})\s*$/i.exec(t);
  if (m) return { kind: "by-number", index: Number(m[1]) };
  m = /^#?(\d{1,3})\s+(?:done|finished|completed?)\s*$/i.exec(t);
  if (m) return { kind: "by-number", index: Number(m[1]) };
  m = /^(?:done|finished|completed?)\s+(.+)$/i.exec(t);
  if (m) return { kind: "by-words", words: m[1].trim() };
  return null;
}

// Index a displayed digest (its stored task_ids, in displayed order).
export function resolveDigestIndex(
  taskIds: readonly number[],
  index: number
): number | null {
  if (!Number.isInteger(index) || index < 1 || index > taskIds.length) return null;
  return taskIds[index - 1];
}

export type TitleMatch =
  | { kind: "one"; id: number }
  | { kind: "many"; candidates: Array<{ id: number; title: string }> }
  | { kind: "none" };

// Case-insensitive substring match of the reply's words against open task
// titles. Exactly one hit completes; several ask which; zero falls through
// (the words may name a task only a model can associate).
export function matchTitles(
  words: string,
  openTasks: ReadonlyArray<{ id: number; title: string }>
): TitleMatch {
  const needle = words.trim().toLowerCase();
  if (!needle) return { kind: "none" };
  const hits = openTasks.filter((t) => t.title.toLowerCase().includes(needle));
  if (hits.length === 1) return { kind: "one", id: hits[0].id };
  if (hits.length > 1) {
    return { kind: "many", candidates: hits.map(({ id, title }) => ({ id, title })) };
  }
  return { kind: "none" };
}

// ---- message formatting --------------------------------------------------------

export type DigestTask = { id: number; title: string; due_at: string | null };

function fmtDue(dueAt: string | null): string {
  if (!dueAt) return "no date";
  const d = new Date(dueAt.length === 10 ? `${dueAt}T12:00:00` : dueAt);
  if (Number.isNaN(d.getTime())) return `due ${dueAt}`;
  return `due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export function numberedTaskLines(tasks: ReadonlyArray<DigestTask>): string[] {
  return tasks.map((t, i) => `${i + 1}. ${t.title} — ${fmtDue(t.due_at)}`);
}

// Midday/evening digest DM. Returns null when there is nothing open — the
// caller sends nothing at all in that case.
export function formatDigestMessage(
  openCount: number,
  top: ReadonlyArray<DigestTask>
): string | null {
  if (openCount === 0 || top.length === 0) return null;
  return [
    `Task check — ${openCount} open`,
    ...numberedTaskLines(top),
    `Reply "done 2" or "done <task words>" to check one off.`,
  ].join("\n");
}

// Reply to an unresolvable number / stale digest reference: re-show the
// board as it stands now.
export function formatCurrentDigestReply(
  lead: string,
  top: ReadonlyArray<DigestTask>
): string {
  if (top.length === 0) return `${lead} Nothing is open right now.`;
  return [lead, ...numberedTaskLines(top)].join("\n");
}

export function formatAmbiguousReply(
  candidates: ReadonlyArray<{ id: number; title: string }>
): string {
  return [
    "That matches more than one open task — which one?",
    ...candidates.map((c, i) => `${i + 1}. ${c.title}`),
    `Reply "done <number>" using the numbers above.`,
  ].join("\n");
}

export function formatCompletionReply(
  title: string,
  stillDueToday: readonly string[]
): string {
  const lines = [`✓ Completed: ${title}`];
  if (stillDueToday.length > 0) {
    lines.push(`Still due today: ${stillDueToday.join("; ")}`);
  }
  return lines.join("\n");
}
