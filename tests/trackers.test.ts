import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import {
  GOAL_TO_TRACKER,
  migrateGoalsToTrackers,
  setTrackerTarget,
} from "../lib/trackers-migrate.ts";
import { manualTrackerLabel, sourcedOnTrack } from "../lib/tracker-progress.ts";
import { findLikelyDuplicate, similarity } from "../lib/tracker-dedupe.ts";

// Minimal in-memory schema mirroring the unified Tracker model.
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
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL UNIQUE,
      target REAL NOT NULL,
      period TEXT NOT NULL DEFAULT 'month'
    );
  `);
  return db;
}

const ALL_KINDS = Object.keys(GOAL_TO_TRACKER);

function seedAllGoals(db: Database.Database) {
  const ins = db.prepare("INSERT INTO goals (kind, target) VALUES (?, ?)");
  ins.run("savings_rate", 30);
  ins.run("gym_days_per_week", 5);
  ins.run("leetcode_per_week", 7);
  ins.run("sleep_hours", 8);
  ins.run("calories_per_day", 2200);
}

test("migration maps all five former goal kinds to sourced trackers", () => {
  const db = freshDb();
  seedAllGoals(db);
  migrateGoalsToTrackers(db);

  const bySource = Object.fromEntries(
    (db.prepare("SELECT source, target, cadence FROM habits").all() as {
      source: string;
      target: number;
      cadence: string;
    }[]).map((r) => [r.source, r])
  );
  assert.equal(Object.keys(bySource).length, ALL_KINDS.length);
  assert.equal(bySource.savings_rate.target, 30);
  assert.equal(bySource.gym_logs.target, 5);
  assert.equal(bySource.leetcode.target, 7);
  assert.equal(bySource.sleep_hours.target, 8);
  assert.equal(bySource.calories.target, 2200);
  // calories is a daily ceiling.
  assert.equal(bySource.calories.cadence, "daily");
});

test("migration merges a pre-existing habit/goal pair into ONE tracker", () => {
  const db = freshDb();
  // A "Gym" habit the user already tracks manually...
  db.prepare("INSERT INTO habits (name, cadence, goal) VALUES ('Gym', 'weekly', 4)").run();
  // ...and a gym_days_per_week goal that refers to the same thing.
  db.prepare("INSERT INTO goals (kind, target) VALUES ('gym_days_per_week', 6)").run();
  migrateGoalsToTrackers(db);

  const gymRows = db
    .prepare("SELECT id, name, source, target FROM habits WHERE source = 'gym_logs' OR name = 'Gym'")
    .all() as { id: number; name: string; source: string | null; target: number | null }[];
  assert.equal(gymRows.length, 1, "no duplicate Gym tracker created");
  assert.equal(gymRows[0].name, "Gym", "existing habit kept");
  assert.equal(gymRows[0].source, "gym_logs", "linked to the gym source");
  assert.equal(gymRows[0].target, 6, "goal target folded in");
});

test("migration is idempotent — running twice is a no-op", () => {
  const db = freshDb();
  seedAllGoals(db);
  migrateGoalsToTrackers(db);
  const first = db.prepare("SELECT COUNT(*) AS n FROM habits").get() as { n: number };
  migrateGoalsToTrackers(db);
  migrateGoalsToTrackers(db);
  const again = db.prepare("SELECT COUNT(*) AS n FROM habits").get() as { n: number };
  assert.equal(again.n, first.n, "no duplicate trackers on re-run");
});

test("cadence label: daily speaks in streaks, weekly in count-vs-target (the bug)", () => {
  const daily = manualTrackerLabel("daily", { streak: 12, thisWeek: 3, goal: 5, doneToday: true });
  assert.match(daily, /12-day streak/);
  assert.doesNotMatch(daily, /per week|this week/, "daily must NOT use weekly language");

  const weekly = manualTrackerLabel("weekly", { streak: 0, thisWeek: 4, goal: 6, doneToday: false });
  assert.match(weekly, /4 of 6 this week/);
  assert.doesNotMatch(weekly, /streak/, "weekly must not use streak language");
});

test("sourcedOnTrack treats calories as a ceiling, others as floors", () => {
  assert.equal(sourcedOnTrack("gym_logs", 5, 4), true); // met the floor
  assert.equal(sourcedOnTrack("gym_logs", 3, 4), false);
  assert.equal(sourcedOnTrack("calories", 1800, 2200), true); // under the ceiling
  assert.equal(sourcedOnTrack("calories", 2500, 2200), false);
});

test("duplicate detection: clearly-same names match, clearly-different don't", () => {
  assert.ok(similarity("Gym", "gym") === 1);
  assert.ok(similarity("Go to the gym", "Gym") >= 0.5);
  assert.ok(similarity("Read 20 minutes", "Meditate") < 0.5);

  const existing = [
    { id: 1, name: "Gym", source: "gym_logs" },
    { id: 2, name: "Read", source: null },
  ];
  // "workout" matches the gym-linked tracker via its source keywords.
  const dup = findLikelyDuplicate("Workout", existing);
  assert.equal(dup?.id, 1);
  // Something genuinely new → no suggestion.
  assert.equal(findLikelyDuplicate("Learn Spanish", existing), null);
});

test("set_goal alias writes a unified Tracker target (create then update)", () => {
  const db = freshDb();
  // Fresh: creates the Sleep tracker with the target.
  setTrackerTarget(db, "sleep_hours", 8);
  let row = db.prepare("SELECT name, source, target FROM habits WHERE source = 'sleep_hours'").get() as {
    name: string;
    source: string;
    target: number;
  };
  assert.equal(row.source, "sleep_hours");
  assert.equal(row.target, 8);
  // Again with a new target: updates the SAME tracker, no duplicate.
  setTrackerTarget(db, "sleep_hours", 7);
  const count = db.prepare("SELECT COUNT(*) AS n FROM habits WHERE source = 'sleep_hours'").get() as {
    n: number;
  };
  assert.equal(count.n, 1);
  row = db.prepare("SELECT name, source, target FROM habits WHERE source = 'sleep_hours'").get() as {
    name: string;
    source: string;
    target: number;
  };
  assert.equal(row.target, 7);
});
