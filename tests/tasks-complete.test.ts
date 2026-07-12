import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { completeTaskCore, stillDueToday } from "../lib/tasks/complete.ts";

// The one write path for task completion. The idempotency contract lives
// HERE (not in any parser), so every entry point — agent tool, Slack reply,
// future callers — inherits it: already-done is a successful no-op that
// must not re-fire the calendar close; a missing id is a typed not-found.

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    completed_at TEXT
  )`);
  return db;
}

const NOW = () => "2026-07-12T15:00:00.000Z";

test("completing an open task sets completed_at and status together", () => {
  const db = freshDb();
  db.exec(`INSERT INTO tasks (title) VALUES ('call bank')`);
  const result = completeTaskCore(db, 1, NOW);
  assert.deepEqual(result, { outcome: "completed", title: "call bank" });
  const row = db.prepare("SELECT status, completed_at FROM tasks WHERE id = 1").get() as {
    status: string;
    completed_at: string;
  };
  assert.equal(row.status, "done");
  assert.equal(row.completed_at, NOW());
});

test("already-completed task: successful no-op, timestamp untouched (idempotent)", () => {
  const db = freshDb();
  db.exec(
    `INSERT INTO tasks (title, status, completed_at) VALUES ('call bank', 'done', '2026-07-11T09:00:00.000Z')`
  );
  const result = completeTaskCore(db, 1, NOW);
  assert.deepEqual(result, { outcome: "already-done", title: "call bank" });
  const row = db.prepare("SELECT completed_at FROM tasks WHERE id = 1").get() as {
    completed_at: string;
  };
  // A duplicate "done 2" reply must not move the completion time — and the
  // caller keys the calendar no-op off this same outcome.
  assert.equal(row.completed_at, "2026-07-11T09:00:00.000Z");
});

test("nonexistent task id: typed not-found, no throw", () => {
  const db = freshDb();
  assert.deepEqual(completeTaskCore(db, 999, NOW), { outcome: "not-found" });
});

test("stillDueToday lists open tasks due today or overdue, oldest first", () => {
  const db = freshDb();
  db.exec(`INSERT INTO tasks (title, due_at) VALUES ('overdue', '2026-07-10')`);
  db.exec(`INSERT INTO tasks (title, due_at) VALUES ('today', '2026-07-12')`);
  db.exec(`INSERT INTO tasks (title, due_at) VALUES ('tomorrow', '2026-07-13')`);
  db.exec(`INSERT INTO tasks (title, due_at, status, completed_at)
           VALUES ('done today', '2026-07-12', 'done', '2026-07-12T10:00:00.000Z')`);
  db.exec(`INSERT INTO tasks (title) VALUES ('dateless')`);
  assert.deepEqual(stillDueToday(db, "2026-07-12"), ["overdue", "today"]);
});
