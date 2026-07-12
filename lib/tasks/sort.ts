// Pure display ordering for the tasks board — the one place column sorting
// lives. This consumes the llm_rank / due_at / created_at fields already
// present on each row; it never computes or re-derives a rank (that's
// lib/tasks/rank.ts's job — rank.ts decides what number llm_rank holds,
// sort.ts only decides how to order rows given the numbers already there).
// Before the ranker ships (llm_rank null on every row) the due_at →
// created_at fallback below still yields a stable, correct ordering.

export type SortableTask = {
  llm_rank: number | null;
  due_at: string | null;
  created_at: string;
};

// Precedence within a column:
//   1. llm_rank ascending, nulls last
//   2. among rank-nulls, due_at ascending (ISO strings — lexicographic works),
//      nulls last
//   3. remaining ties: created_at ascending
export function compareTasks(a: SortableTask, b: SortableTask): number {
  if (a.llm_rank != null || b.llm_rank != null) {
    if (a.llm_rank == null) return 1;
    if (b.llm_rank == null) return -1;
    if (a.llm_rank !== b.llm_rank) return a.llm_rank - b.llm_rank;
  }
  if (a.due_at !== b.due_at) {
    if (a.due_at == null) return 1;
    if (b.due_at == null) return -1;
    if (a.due_at !== b.due_at) return a.due_at < b.due_at ? -1 : 1;
  }
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return 0;
}

export function sortTasks<T extends SortableTask>(tasks: readonly T[]): T[] {
  return [...tasks].sort(compareTasks);
}
