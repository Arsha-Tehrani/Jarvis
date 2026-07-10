import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { deleteTracker, findHabitByName } from "../lib/tracker-delete.ts";

// Minimal in-memory schema: the unified habits table, its logs, and one
// underlying source table (gym_logs) to prove sourced deletes never touch it.
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      cadence TEXT NOT NULL DEFAULT 'daily',
      goal INTEGER NOT NULL DEFAULT 1,
      source TEXT,
      target REAL
    );
    CREATE TABLE habit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      UNIQUE(habit_id, date)
    );
    CREATE TABLE gym_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      notes TEXT
    );
  `);
  return db;
}

test("manual habit delete cascades its logs — both actually gone", () => {
  const db = freshDb();
  const { lastInsertRowid: id } = db
    .prepare("INSERT INTO habits (name) VALUES ('Reading')")
    .run();
  db.prepare("INSERT INTO habit_logs (habit_id, date) VALUES (?, '2026-07-08')").run(id);
  db.prepare("INSERT INTO habit_logs (habit_id, date) VALUES (?, '2026-07-09')").run(id);
  db.prepare("INSERT INTO habit_logs (habit_id, date) VALUES (?, '2026-07-10')").run(id);

  const result = deleteTracker(db, Number(id));
  assert.deepEqual(result, { kind: "manual", name: "Reading", deletedLogs: 3 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM habits").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM habit_logs").get() as { n: number }).n, 0);
});

test("manual delete only removes that habit's logs, not another habit's", () => {
  const db = freshDb();
  const a = db.prepare("INSERT INTO habits (name) VALUES ('Reading')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO habits (name) VALUES ('Meditate')").run().lastInsertRowid;
  db.prepare("INSERT INTO habit_logs (habit_id, date) VALUES (?, '2026-07-10')").run(a);
  db.prepare("INSERT INTO habit_logs (habit_id, date) VALUES (?, '2026-07-10')").run(b);

  deleteTracker(db, Number(a));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM habit_logs WHERE habit_id = ?").get(b) as { n: number }).n, 1);
});

test("sourced tracker delete removes only the config row — the source table survives", () => {
  const db = freshDb();
  const id = db
    .prepare("INSERT INTO habits (name, source, target) VALUES ('Gym', 'gym_logs', 5)")
    .run().lastInsertRowid;
  db.prepare("INSERT INTO gym_logs (date, notes) VALUES ('2026-07-09', 'leg day')").run();
  db.prepare("INSERT INTO gym_logs (date, notes) VALUES ('2026-07-10', 'push day')").run();

  const result = deleteTracker(db, Number(id));
  assert.deepEqual(result, { kind: "sourced", name: "Gym", source: "gym_logs" });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM habits").get() as { n: number }).n, 0);
  // The underlying feed belongs to its own feature — untouched.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM gym_logs").get() as { n: number }).n, 2);
});

test("unknown id throws Tracker not found", () => {
  const db = freshDb();
  assert.throws(() => deleteTracker(db, 999), /Tracker not found/);
});

test("findHabitByName matches case-insensitively", () => {
  const db = freshDb();
  db.prepare("INSERT INTO habits (name) VALUES ('Reading')").run();
  const habit = findHabitByName(db, "  reading ");
  assert.equal(habit.name, "Reading");
  assert.equal(habit.source, null);
});

test("findHabitByName fails with the known-trackers list, like log_habit always has", () => {
  const db = freshDb();
  db.prepare("INSERT INTO habits (name) VALUES ('Reading')").run();
  db.prepare("INSERT INTO habits (name, source) VALUES ('Gym', 'gym_logs')").run();
  assert.throws(
    () => findHabitByName(db, "Jogging"),
    /No habit named "Jogging"\. Existing habits: Gym, Reading/
  );
});

test("findHabitByName with an empty table names the fix, not just the failure", () => {
  const db = freshDb();
  assert.throws(() => findHabitByName(db, "Anything"), /create one on the Habits page first/);
});
