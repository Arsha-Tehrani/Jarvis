import assert from "node:assert/strict";
import { test } from "node:test";
import { sortTasks, type SortableTask } from "../lib/tasks/sort.ts";

// Display-ordering contract for the board columns: llm_rank ascending
// (nulls last), then due_at ascending (nulls last), then created_at.
// sort.ts must produce a stable, correct ordering even before the ranker
// has ever run (llm_rank null on every row).

const t = (
  llm_rank: number | null,
  due_at: string | null,
  created_at: string,
  label: string
): SortableTask & { label: string } => ({ llm_rank, due_at, created_at, label });

const labels = (rows: Array<{ label: string }>) => rows.map((r) => r.label);

test("rank present on every row: ascending rank wins regardless of dates", () => {
  const rows = [
    t(3, "2026-07-01", "2026-06-01", "c"),
    t(1, null, "2026-06-03", "a"),
    t(2, "2026-07-20", "2026-06-02", "b"),
  ];
  assert.deepEqual(labels(sortTasks(rows)), ["a", "b", "c"]);
});

test("rank absent everywhere: due_at ascending, then created_at", () => {
  const rows = [
    t(null, "2026-07-20", "2026-06-01", "later-due"),
    t(null, "2026-07-01", "2026-06-05", "sooner-due"),
    t(null, null, "2026-06-02", "no-due-older"),
    t(null, null, "2026-06-04", "no-due-newer"),
  ];
  assert.deepEqual(labels(sortTasks(rows)), [
    "sooner-due",
    "later-due",
    "no-due-older",
    "no-due-newer",
  ]);
});

test("mixed: ranked rows come first (by rank), unranked fall back to due/created", () => {
  const rows = [
    t(null, "2026-07-01", "2026-06-01", "unranked-dated"),
    t(2, null, "2026-06-09", "rank2"),
    t(null, null, "2026-06-08", "unranked-undated"),
    t(1, "2026-08-01", "2026-06-01", "rank1"),
  ];
  assert.deepEqual(labels(sortTasks(rows)), [
    "rank1",
    "rank2",
    "unranked-dated",
    "unranked-undated",
  ]);
});

test("no due dates at all: created_at ascending is the whole ordering", () => {
  const rows = [
    t(null, null, "2026-06-03", "third"),
    t(null, null, "2026-06-01", "first"),
    t(null, null, "2026-06-02", "second"),
  ];
  assert.deepEqual(labels(sortTasks(rows)), ["first", "second", "third"]);
});

test("overdue ordering: an overdue due_at sorts before today and future dates", () => {
  const rows = [
    t(null, "2026-07-14", "2026-06-01", "future"),
    t(null, "2026-07-10", "2026-06-01", "overdue"),
    t(null, "2026-07-12", "2026-06-01", "today"),
  ];
  assert.deepEqual(labels(sortTasks(rows)), ["overdue", "today", "future"]);
});

test("equal rank ties break by due date, then created_at", () => {
  const rows = [
    t(1, "2026-07-20", "2026-06-02", "b"),
    t(1, "2026-07-01", "2026-06-05", "a"),
    t(1, null, "2026-06-04", "d"),
    t(1, null, "2026-06-01", "c"),
  ];
  assert.deepEqual(labels(sortTasks(rows)), ["a", "b", "c", "d"]);
});

test("input array is not mutated", () => {
  const rows = [
    t(null, null, "2026-06-02", "second"),
    t(null, null, "2026-06-01", "first"),
  ];
  const before = labels(rows);
  sortTasks(rows);
  assert.deepEqual(labels(rows), before);
});
