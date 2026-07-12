import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import {
  applyDeterministicRanks,
  computeRanks,
  type RankableTask,
} from "../lib/tasks/rank.ts";
import { applyLlmRankings, parseRankings } from "../lib/tasks/rank-llm-core.ts";

// Phase 3 contract: the deterministic ranker always produces a total, stable
// ranking; the zod gate rejects every malformed model reply so unvalidated
// output never touches the database; llm_rank_source records which writer
// last touched a row and survives a failed LLM pass unchanged.

const t = (
  id: number,
  due_at: string | null,
  priority: RankableTask["priority"],
  created_at = "2026-07-01T00:00:00.000Z"
): RankableTask => ({ id, due_at, priority, created_at });

const order = (tasks: RankableTask[]) =>
  computeRanks(tasks)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.id);

// ---- deterministic ranker ------------------------------------------------------

test("overdue first, then ascending due date", () => {
  const ids = order([
    t(1, "2026-07-20", "later"),
    t(2, "2026-07-01", "later"), // most overdue
    t(3, "2026-07-10", "later"),
  ]);
  assert.deepEqual(ids, [2, 3, 1]);
});

test("urgent > high > later breaks ties on the same due date", () => {
  const ids = order([
    t(1, "2026-07-14", "later"),
    t(2, "2026-07-14", "urgent"),
    t(3, "2026-07-14", "high"),
  ]);
  assert.deepEqual(ids, [2, 3, 1]);
});

test("no-due-date tasks rank after every dated task, ordered by priority", () => {
  const ids = order([
    t(1, null, "urgent"),
    t(2, "2026-12-31", "later"), // dated, far future — still beats undated urgent
    t(3, null, "later"),
    t(4, null, "high"),
  ]);
  assert.deepEqual(ids, [2, 1, 4, 3]);
});

test("created_at then id close out remaining ties (total, stable order)", () => {
  const ids = order([
    t(2, null, "high", "2026-07-02T00:00:00.000Z"),
    t(1, null, "high", "2026-07-01T00:00:00.000Z"),
    t(4, null, "high", "2026-07-03T00:00:00.000Z"),
    t(3, null, "high", "2026-07-03T00:00:00.000Z"),
  ]);
  assert.deepEqual(ids, [1, 2, 3, 4]);
});

test("ranks are exactly 1..N", () => {
  const ranks = computeRanks([t(1, null, "later"), t(2, "2026-07-14", "urgent"), t(3, null, "high")])
    .map((r) => r.rank)
    .sort();
  assert.deepEqual(ranks, [1, 2, 3]);
});

// ---- zod gate ------------------------------------------------------------------

const OPEN_IDS = [10, 20, 30];
const good = JSON.stringify({
  rankings: [
    { id: 20, rank: 1, suggested_priority: "urgent", rationale: "deadline tomorrow" },
    { id: 10, rank: 2, suggested_priority: "high", rationale: "blocks the rest" },
    { id: 30, rank: 3, suggested_priority: "later", rationale: "no rush" },
  ],
});

test("valid reply parses; rationale is capped at 120 chars", () => {
  const long = JSON.stringify({
    rankings: [
      { id: 10, rank: 1, suggested_priority: "high", rationale: "x".repeat(300) },
      { id: 20, rank: 2, suggested_priority: "high", rationale: "ok" },
      { id: 30, rank: 3, suggested_priority: "later", rationale: "ok" },
    ],
  });
  const parsed = parseRankings(long, OPEN_IDS);
  assert.ok(parsed);
  assert.equal(parsed![0].rationale.length, 120);
  assert.ok(parseRankings(good, OPEN_IDS));
});

test("a ```json fence around otherwise-valid JSON is tolerated", () => {
  assert.ok(parseRankings("```json\n" + good + "\n```", OPEN_IDS));
});

test("non-JSON is rejected", () => {
  assert.equal(parseRankings("I think task 20 is most important!", OPEN_IDS), null);
});

test("missing id is rejected", () => {
  const missing = JSON.stringify({
    rankings: [
      { id: 10, rank: 1, suggested_priority: "high", rationale: "a" },
      { id: 20, rank: 2, suggested_priority: "high", rationale: "b" },
    ],
  });
  assert.equal(parseRankings(missing, OPEN_IDS), null);
});

test("extra id (not an open task) is rejected", () => {
  const extra = JSON.stringify({
    rankings: [
      { id: 10, rank: 1, suggested_priority: "high", rationale: "a" },
      { id: 20, rank: 2, suggested_priority: "high", rationale: "b" },
      { id: 999, rank: 3, suggested_priority: "later", rationale: "c" },
    ],
  });
  assert.equal(parseRankings(extra, OPEN_IDS), null);
});

test("duplicate rank is rejected", () => {
  const dup = JSON.stringify({
    rankings: [
      { id: 10, rank: 1, suggested_priority: "high", rationale: "a" },
      { id: 20, rank: 1, suggested_priority: "high", rationale: "b" },
      { id: 30, rank: 3, suggested_priority: "later", rationale: "c" },
    ],
  });
  assert.equal(parseRankings(dup, OPEN_IDS), null);
});

test("rank outside 1..N and bad enum are rejected", () => {
  const outOfRange = JSON.stringify({
    rankings: [
      { id: 10, rank: 1, suggested_priority: "high", rationale: "a" },
      { id: 20, rank: 2, suggested_priority: "high", rationale: "b" },
      { id: 30, rank: 7, suggested_priority: "later", rationale: "c" },
    ],
  });
  assert.equal(parseRankings(outOfRange, OPEN_IDS), null);
  const badEnum = good.replace('"urgent"', '"critical"');
  assert.equal(parseRankings(badEnum, OPEN_IDS), null);
});

// ---- llm_rank_source bookkeeping -------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    due_at TEXT,
    priority TEXT NOT NULL DEFAULT 'high',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT '2026-07-01T00:00:00.000Z',
    llm_rank INTEGER,
    llm_rank_source TEXT,
    llm_suggested_priority TEXT,
    llm_rationale TEXT
  )`);
  return db;
}

test("deterministic ranker writes llm_rank + llm_rank_source='deterministic' for open tasks only", () => {
  const db = freshDb();
  db.exec(`INSERT INTO tasks (title, due_at, priority) VALUES ('a', '2026-07-14', 'later')`);
  db.exec(`INSERT INTO tasks (title, due_at, priority) VALUES ('b', '2026-07-10', 'urgent')`);
  db.exec(`INSERT INTO tasks (title, status) VALUES ('done one', 'done')`);

  applyDeterministicRanks(db);
  const rows = db.prepare("SELECT id, llm_rank, llm_rank_source FROM tasks ORDER BY id").all() as
    Array<{ id: number; llm_rank: number | null; llm_rank_source: string | null }>;
  assert.deepEqual(rows, [
    { id: 1, llm_rank: 2, llm_rank_source: "deterministic" },
    { id: 2, llm_rank: 1, llm_rank_source: "deterministic" },
    { id: 3, llm_rank: null, llm_rank_source: null },
  ]);
});

test("a validated LLM pass writes source='llm' and only disagreeing suggestions", () => {
  const db = freshDb();
  db.exec(`INSERT INTO tasks (title, priority) VALUES ('a', 'high')`);
  db.exec(`INSERT INTO tasks (title, priority) VALUES ('b', 'later')`);
  applyDeterministicRanks(db);

  const rankings = parseRankings(
    JSON.stringify({
      rankings: [
        { id: 1, rank: 2, suggested_priority: "high", rationale: "agrees" },
        { id: 2, rank: 1, suggested_priority: "urgent", rationale: "deadline is implicit" },
      ],
    }),
    [1, 2]
  );
  assert.ok(rankings);
  applyLlmRankings(db, rankings!);

  const rows = db
    .prepare(
      "SELECT id, llm_rank, llm_rank_source, llm_suggested_priority, llm_rationale FROM tasks ORDER BY id"
    )
    .all() as Array<Record<string, unknown>>;
  // Agreeing suggestion cleared; disagreeing one stored with its rationale.
  assert.deepEqual(rows, [
    { id: 1, llm_rank: 2, llm_rank_source: "llm", llm_suggested_priority: null, llm_rationale: null },
    { id: 2, llm_rank: 1, llm_rank_source: "llm", llm_suggested_priority: "urgent", llm_rationale: "deadline is implicit" },
  ]);
});

test("a failed validation leaves ranks AND llm_rank_source at their prior deterministic values", () => {
  const db = freshDb();
  db.exec(`INSERT INTO tasks (title, due_at, priority) VALUES ('a', '2026-07-14', 'high')`);
  db.exec(`INSERT INTO tasks (title, priority) VALUES ('b', 'later')`);
  applyDeterministicRanks(db);
  const before = db.prepare("SELECT id, llm_rank, llm_rank_source FROM tasks ORDER BY id").all();

  // The gate rejects — so nothing is ever applied (mirrors rank-llm.ts flow).
  const rejected = parseRankings("{ not json", [1, 2]);
  assert.equal(rejected, null);

  const after = db.prepare("SELECT id, llm_rank, llm_rank_source FROM tasks ORDER BY id").all();
  assert.deepEqual(after, before);
  assert.equal((after[0] as { llm_rank_source: string }).llm_rank_source, "deterministic");
});

test("LLM pass never touches priority itself — suggestions are advisory only", () => {
  const db = freshDb();
  db.exec(`INSERT INTO tasks (title, priority) VALUES ('a', 'later')`);
  const rankings = parseRankings(
    JSON.stringify({
      rankings: [{ id: 1, rank: 1, suggested_priority: "urgent", rationale: "do it now" }],
    }),
    [1]
  );
  applyLlmRankings(db, rankings!);
  const row = db.prepare("SELECT priority, llm_suggested_priority FROM tasks").get() as {
    priority: string;
    llm_suggested_priority: string;
  };
  assert.equal(row.priority, "later");
  assert.equal(row.llm_suggested_priority, "urgent");
});
