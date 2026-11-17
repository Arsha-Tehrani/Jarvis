import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import {
  handleTrackerResponse,
  type TrackerHabit,
} from "../lib/slack/tracker-response.ts";

// handleTrackerResponse is plain application logic: db passed in, completion
// logger injected, no Slack types. So it's driven directly against an
// in-memory DB — no socket, no Slack API, no mocking beyond the database.

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      cadence TEXT NOT NULL DEFAULT 'daily',
      goal INTEGER NOT NULL DEFAULT 1,
      source TEXT,
      target REAL,
      checkin_enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
    );
    CREATE TABLE tracker_misses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(habit_id, date)
    );
    CREATE TABLE agent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_text TEXT NOT NULL,
      tool_calls TEXT,
      result TEXT,
      created_at TEXT
    );
    INSERT INTO habits (id, name, source) VALUES
      (1, 'Gym', 'gym_logs'),
      (2, 'Read', NULL);
  `);
  return db;
}

// Records what the injected logger was asked to do, so "yes" can be asserted
// without touching the real tool registry.
function spyLogger() {
  const calls: Array<{ habit: TrackerHabit; date: string }> = [];
  return {
    calls,
    log: async (habit: TrackerHabit, date: string) => {
      calls.push({ habit, date });
      return `Logged "${habit.name}" for ${date}.`;
    },
  };
}

const YESTERDAY = "2026-08-08";

test("yes logs through the injected logger with the HISTORICAL date", async () => {
  const db = freshDb();
  const logger = spyLogger();
  const result = await handleTrackerResponse(
    { db, logCompletion: logger.log },
    { habitId: 1, date: YESTERDAY, response: "yes" }
  );

  assert.equal(logger.calls.length, 1);
  assert.equal(logger.calls[0].date, YESTERDAY); // not today
  assert.equal(logger.calls[0].habit.source, "gym_logs");
  assert.equal(result.answer, "yes");
  assert.match(result.confirmationText, /✅/);
  // A yes writes to the tracker's own table, never to tracker_misses.
  assert.equal((db.prepare("SELECT COUNT(*) n FROM tracker_misses").get() as { n: number }).n, 0);
});

test("no records an explicit miss and never calls the logger", async () => {
  const db = freshDb();
  const logger = spyLogger();
  const result = await handleTrackerResponse(
    { db, logCompletion: logger.log },
    { habitId: 2, date: YESTERDAY, response: "no" }
  );

  assert.equal(logger.calls.length, 0);
  assert.equal(result.answer, "no");
  assert.match(result.confirmationText, /🔴/);
  const rows = db.prepare("SELECT habit_id, date FROM tracker_misses").all();
  assert.deepEqual(rows, [{ habit_id: 2, date: YESTERDAY }]);
});

test("a repeated no is idempotent — one miss row, not two", async () => {
  // Matters because Slack can redeliver, and a double-tap is easy.
  const db = freshDb();
  const logger = spyLogger();
  const input = { habitId: 2, date: YESTERDAY, response: "no" as const };
  await handleTrackerResponse({ db, logCompletion: logger.log }, input);
  await handleTrackerResponse({ db, logCompletion: logger.log }, input);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM tracker_misses").get() as { n: number }).n, 1);
});

test("both answers are written to agent_log with tracker, date, and answer", async () => {
  const db = freshDb();
  const logger = spyLogger();
  await handleTrackerResponse(
    { db, logCompletion: logger.log },
    { habitId: 1, date: YESTERDAY, response: "yes" }
  );
  await handleTrackerResponse(
    { db, logCompletion: logger.log },
    { habitId: 2, date: YESTERDAY, response: "no" }
  );

  const rows = db.prepare("SELECT user_text, tool_calls FROM agent_log ORDER BY id").all() as Array<{
    user_text: string;
    tool_calls: string;
  }>;
  assert.equal(rows.length, 2);
  assert.match(rows[0].user_text, /yes — "Gym" for 2026-08-08/);
  assert.equal(JSON.parse(rows[0].tool_calls).executed[0].name, "log_gym");
  assert.match(rows[1].user_text, /no — "Read" for 2026-08-08/);
  assert.equal(JSON.parse(rows[1].tool_calls).executed[0].name, "mark_tracker_missed");
});

test("a manual habit routes to log_habit, a leetcode tracker to log_leetcode", async () => {
  const db = freshDb();
  db.prepare("INSERT INTO habits (id, name, source) VALUES (3, 'LeetCode', 'leetcode')").run();
  const logger = spyLogger();
  await handleTrackerResponse(
    { db, logCompletion: logger.log },
    { habitId: 2, date: YESTERDAY, response: "yes" }
  );
  await handleTrackerResponse(
    { db, logCompletion: logger.log },
    { habitId: 3, date: YESTERDAY, response: "yes" }
  );
  const names = (
    db.prepare("SELECT tool_calls FROM agent_log ORDER BY id").all() as { tool_calls: string }[]
  ).map((r) => JSON.parse(r.tool_calls).executed[0].name);
  assert.deepEqual(names, ["log_habit", "log_leetcode"]);
});

test("an unknown or deleted tracker throws instead of writing anything", async () => {
  const db = freshDb();
  const logger = spyLogger();
  await assert.rejects(
    () =>
      handleTrackerResponse(
        { db, logCompletion: logger.log },
        { habitId: 99, date: YESTERDAY, response: "no" }
      ),
    /Tracker 99 not found/
  );

  db.prepare("UPDATE habits SET deleted_at = '2026-08-01' WHERE id = 2").run();
  await assert.rejects(
    () =>
      handleTrackerResponse(
        { db, logCompletion: logger.log },
        { habitId: 2, date: YESTERDAY, response: "no" }
      ),
    /Tracker 2 not found/
  );
  assert.equal((db.prepare("SELECT COUNT(*) n FROM tracker_misses").get() as { n: number }).n, 0);
});

test("a malformed date is rejected before any write", async () => {
  const db = freshDb();
  const logger = spyLogger();
  await assert.rejects(
    () =>
      handleTrackerResponse(
        { db, logCompletion: logger.log },
        { habitId: 2, date: "08/08/2026", response: "no" }
      ),
    /Invalid date/
  );
  assert.equal((db.prepare("SELECT COUNT(*) n FROM tracker_misses").get() as { n: number }).n, 0);
  assert.equal(logger.calls.length, 0);
});
