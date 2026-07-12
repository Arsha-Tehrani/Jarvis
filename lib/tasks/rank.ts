// Deterministic task ranker — the always-working half of task ranking.
// Pure scoring plus a DbLike-writing applier (db passed in, same pattern as
// lib/sync/core.ts) so node --test exercises both against in-memory sqlite.
//
// The deterministic result is stored in llm_rank — it is the fallback
// content of the same field the LLM refinement pass (rank-llm.ts) writes.
// llm_rank_source records which writer touched the row last:
// 'deterministic' here, 'llm' there. sort.ts (display ordering) consumes
// llm_rank without caring which writer produced it.

export type DbLike = {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
};

export type Priority = "urgent" | "high" | "later";

export type RankableTask = {
  id: number;
  due_at: string | null;
  priority: Priority;
  created_at: string;
};

const PRIORITY_WEIGHT: Record<Priority, number> = { urgent: 0, high: 1, later: 2 };

// Ordering: dated tasks first, ascending due date (overdue is simply the
// smallest due date, so it naturally leads), priority as tiebreak within a
// date; undated tasks follow, ordered by priority then age. created_at and
// id close out ties so the ranking is total and stable.
export function compareForRank(a: RankableTask, b: RankableTask): number {
  if ((a.due_at == null) !== (b.due_at == null)) return a.due_at == null ? 1 : -1;
  if (a.due_at != null && b.due_at != null && a.due_at !== b.due_at) {
    return a.due_at < b.due_at ? -1 : 1;
  }
  const pw = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (pw !== 0) return pw;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id - b.id;
}

// Ordered task ids → rank 1..N.
export function computeRanks(tasks: readonly RankableTask[]): Array<{ id: number; rank: number }> {
  return [...tasks]
    .sort(compareForRank)
    .map((t, i) => ({ id: t.id, rank: i + 1 }));
}

// Runs synchronously after every task create/edit: rank every open task and
// store the result with llm_rank_source='deterministic'. The LLM pass may
// later overwrite both fields; the next deterministic run reclaims them.
export function applyDeterministicRanks(db: DbLike): number {
  const open = db
    .prepare(
      `SELECT id, due_at, priority, created_at FROM tasks WHERE status = 'open'`
    )
    .all() as RankableTask[];
  const update = db.prepare(
    `UPDATE tasks SET llm_rank = ?, llm_rank_source = 'deterministic' WHERE id = ?`
  );
  for (const { id, rank } of computeRanks(open)) update.run(rank, id);
  return open.length;
}
