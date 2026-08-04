import type Database from "better-sqlite3";
// Relative import so node --test can load this migration with an in-memory DB.
import { normalizeTrackerName } from "./tracker-dedupe.ts";

// Goals → Trackers migration. A "Tracker" is a row in the (generalized)
// `habits` table: `source` links it to a built-in data feed (or null for a
// manual habit) and `target` is the numeric goal that used to live in the
// separate `goals` table. This folds Goals into Trackers so there's one model,
// one place things are tracked. Idempotent (safe to run on every startup) and
// it MERGES a pre-existing habit/goal pair that refer to the same real-world
// thing (e.g. a "Gym" habit + a gym_days_per_week goal) into a single Tracker
// rather than carrying the duplicate forward — that collision is the whole
// reason for the redesign.
//
// `goals` is kept as a legacy table (backup/restore) but is no longer written.

type TrackerSpec = {
  name: string;
  source: string;
  cadence: "daily" | "weekly";
  // Extra name fragments that indicate an existing habit is "the same thing".
  aliases: string[];
};

export const GOAL_TO_TRACKER: Record<string, TrackerSpec> = {
  savings_rate: { name: "Savings rate", source: "savings_rate", cadence: "weekly", aliases: ["saving", "savings"] },
  gym_days_per_week: { name: "Gym", source: "gym_logs", cadence: "weekly", aliases: ["gym", "workout", "exercise", "lift"] },
  leetcode_per_week: { name: "LeetCode", source: "leetcode", cadence: "weekly", aliases: ["leetcode", "coding", "lc"] },
  sleep_hours: { name: "Sleep", source: "sleep_hours", cadence: "weekly", aliases: ["sleep"] },
  // calories is a daily ceiling, not a floor — preserved by the source key.
  calories_per_day: { name: "Calories", source: "calories", cadence: "daily", aliases: ["calorie", "calories", "macro", "macros"] },
};

// Does an existing habit name refer to the same thing this spec tracks?
function nameMatches(habitName: string, spec: TrackerSpec): boolean {
  const n = normalizeTrackerName(habitName);
  if (n === normalizeTrackerName(spec.name)) return true;
  return spec.aliases.some((a) => n === a || n.includes(a) || a.includes(n));
}

// Set/update a Tracker's numeric target from a former goal kind. This is what
// the set_goal tool and the /api/finance/goals endpoint now do instead of
// writing the legacy `goals` table — a goal is just a target on a Tracker.
// Updates the existing source-linked tracker if there is one (so a merged
// habit keeps its name); otherwise creates the Tracker. Takes a db handle so
// it's unit-testable with an in-memory database.
export function setTrackerTarget(db: Database.Database, kind: string, target: number): void {
  const spec = GOAL_TO_TRACKER[kind];
  if (!spec) return;
  const existing = db.prepare("SELECT id FROM habits WHERE source = ?").get(spec.source) as
    | { id: number }
    | undefined;
  if (existing) {
    // Setting a goal on a tombstoned sourced tracker revives it — the user
    // is clearly asking for the tracker back.
    db.prepare("UPDATE habits SET target = ?, deleted_at = NULL WHERE id = ?").run(
      target,
      existing.id
    );
    return;
  }
  db.prepare(
    `INSERT INTO habits (name, cadence, goal, source, target) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET source = excluded.source, target = excluded.target,
       cadence = excluded.cadence, deleted_at = NULL`
  ).run(spec.name, spec.cadence, Math.max(1, Math.round(target)), spec.source, target);
}

export function migrateGoalsToTrackers(db: Database.Database): void {
  // No goals table yet (fresh DB before that migration) → nothing to do.
  const hasGoals = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='goals'")
    .get();
  if (!hasGoals) return;

  const goals = db.prepare("SELECT kind, target FROM goals").all() as {
    kind: string;
    target: number;
  }[];

  const upd = db.prepare("UPDATE habits SET source = ?, target = ?, cadence = ? WHERE id = ?");
  const ins = db.prepare(
    `INSERT INTO habits (name, cadence, goal, source, target) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET source = excluded.source, target = excluded.target, cadence = excluded.cadence`
  );

  for (const g of goals) {
    const spec = GOAL_TO_TRACKER[g.kind];
    if (!spec) continue;

    // Idempotent: already migrated once a tracker with this source exists.
    // Deliberately NOT filtered on deleted_at — a tombstoned sourced tracker
    // still counts as "migrated once"; re-running must not resurrect it.
    const already = db.prepare("SELECT id FROM habits WHERE source = ?").get(spec.source);
    if (already) continue;

    // Merge into a same-thing habit if one exists; otherwise create a Tracker.
    const habits = db.prepare("SELECT id, name FROM habits").all() as {
      id: number;
      name: string;
    }[];
    const match = habits.find((h) => nameMatches(h.name, spec));
    if (match) {
      upd.run(spec.source, g.target, spec.cadence, match.id);
    } else {
      ins.run(spec.name, spec.cadence, Math.max(1, Math.round(g.target)), spec.source, g.target);
    }
  }
}
