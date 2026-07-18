import { getDb } from "@/lib/db";
import { chat } from "@/lib/llm";
import { applyLlmRankings, parseRankings } from "@/lib/tasks/rank-llm-core";

// LLM refinement pass over task ranking — advisory garnish on top of the
// deterministic ranker (rank.ts), never a dependency. Runs debounced 60s
// after task writes, daily at 07:45 (before the 08:00 brief), and at launch.
// Fire-and-forget: never blocks an API response, and on any model error or
// validation failure the deterministic ranks stay untouched (logged once).

const DEBOUNCE_MS = 60_000;

type OpenTask = {
  id: number;
  title: string;
  description: string | null;
  due_at: string | null;
  priority: string;
};

const SYSTEM_PROMPT = [
  "You rank a personal task list by real-world importance.",
  "Consider deadline pressure, downstream consequences of slipping, and the effort implied by each description.",
  'Return STRICT JSON only — no prose, no markdown fences — exactly this shape:',
  '{ "rankings": [{ "id": number, "rank": number, "suggested_priority": "urgent"|"high"|"later", "rationale": "one sentence, max 120 chars" }] }',
  "Every task id must appear exactly once; ranks must be exactly 1..N with rank 1 the most important.",
  "suggested_priority is what the task's priority SHOULD be; repeat its current priority when you agree.",
].join("\n");

export async function refreshLlmRanks(): Promise<void> {
  const db = getDb();
  const open = db
    .prepare(
      `SELECT id, title, description, due_at, priority FROM tasks
       WHERE status = 'open' AND deleted_at IS NULL`
    )
    .all() as OpenTask[];
  if (open.length === 0) return;

  const today = new Date();
  const lines = open.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description ? t.description.slice(0, 200) : null,
    due_at: t.due_at,
    priority: t.priority,
    days_until_due: t.due_at
      ? Math.round(
          (Date.parse(t.due_at.slice(0, 10)) - Date.parse(today.toISOString().slice(0, 10))) /
            86_400_000
        )
      : null,
  }));

  let text: string | undefined;
  try {
    const reply = await chat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ tasks: lines }) },
      ],
    });
    text = reply.text;
  } catch (err) {
    console.log(`[task-rank] LLM pass skipped (model error): ${err instanceof Error ? err.message : err}`);
    return; // deterministic ranks stay
  }

  const rankings = text ? parseRankings(text, open.map((t) => t.id)) : null;
  if (!rankings) {
    console.log("[task-rank] LLM reply failed validation — keeping deterministic ranks");
    return;
  }
  applyLlmRankings(db, rankings);
  console.log(`[task-rank] LLM refinement applied to ${rankings.length} open tasks`);
}

// Debounced trigger for task create/edit paths: one pass fires 60s after
// the last write in a burst. Timer is unref'd so it never holds the
// process open.
const globalForRank = globalThis as unknown as { __jarvisRankTimer?: NodeJS.Timeout };

export function queueLlmRankRefresh(): void {
  if (globalForRank.__jarvisRankTimer) clearTimeout(globalForRank.__jarvisRankTimer);
  const timer = setTimeout(() => {
    globalForRank.__jarvisRankTimer = undefined;
    refreshLlmRanks().catch((err) => console.error("[task-rank] debounced pass failed:", err));
  }, DEBOUNCE_MS);
  timer.unref?.();
  globalForRank.__jarvisRankTimer = timer;
}

// Daily cron (07:45 + launch catch-up).
export async function taskRankLlmJob(): Promise<void> {
  await refreshLlmRanks();
}
