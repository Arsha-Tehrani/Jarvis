import type Database from "better-sqlite3";
// Relative with explicit .ts (not "@/…"): node --test loads this module
// directly and needs a resolvable runtime specifier.
import { tombstone } from "./sync/tombstone.ts";

// Tracker deletion — db passed in (same pattern as trackers-migrate.ts) so
// node --test can exercise the branching against an in-memory DB.
//
// Two very different deletes share one entry point:
// - Manual habit (source IS NULL): the tracker IS the data — deleting it
//   cascades its habit_logs. Real data loss, so every caller (UI dialog,
//   agent tool) must confirm with copy that says what's being lost.
// - Sourced tracker (source IS NOT NULL): the tracker is only the
//   target/cadence config wrapped around a feed that belongs to its own
//   feature (gym_logs, leetcode_stats, health_logs, ...). Deleting it must
//   never touch the underlying feed — that would silently break Gym/LeetCode
//   /health logging elsewhere. A new tracker pointing at the same source can
//   be recreated later with no data loss.

export type DeleteTrackerResult =
  | { kind: "manual"; name: string; deletedLogs: number }
  | { kind: "sourced"; name: string; source: string };

export function deleteTracker(db: Database.Database, id: number): DeleteTrackerResult {
  const row = db
    .prepare("SELECT id, name, source FROM habits WHERE id = ? AND deleted_at IS NULL")
    .get(id) as { id: number; name: string; source: string | null } | undefined;
  if (!row) throw new Error("Tracker not found");

  if (row.source == null) {
    // INTENTIONAL HARD DELETE — the documented exception to the tombstone
    // rule (lib/sync/tombstone.ts). A manual habit IS its data: deleting it
    // cascades its logs, and the confirm dialog promises exactly that —
    // real, irreversible loss. Folding this into the tombstone path would
    // silently make it recoverable, which is a behavior change, not
    // plumbing. Do not "fix" this in a refactor.
    // Explicit cascade inside a transaction (the habit_logs FK also declares
    // ON DELETE CASCADE, but being explicit keeps the behavior visible and
    // independent of the connection's foreign_keys pragma).
    return db.transaction((): DeleteTrackerResult => {
      const { n } = db
        .prepare("SELECT COUNT(*) AS n FROM habit_logs WHERE habit_id = ? AND deleted_at IS NULL")
        .get(row.id) as { n: number };
      db.prepare("DELETE FROM habit_logs WHERE habit_id = ?").run(row.id);
      db.prepare("DELETE FROM habits WHERE id = ?").run(row.id);
      return { kind: "manual", name: row.name, deletedLogs: n };
    })();
  }

  // Sourced tracker: only config wraps the feed — tombstone so the removal
  // propagates to other devices (the feed itself is untouched, as before).
  tombstone(db, "habits", "id = ?", [row.id]);
  return { kind: "sourced", name: row.name, source: row.source };
}

// Case-insensitive name → habit row, failing with the list of known trackers
// so the model (or a user typo) can self-correct — the same behavior
// log_habit has always had; it now shares this one lookup.
export function findHabitByName(
  db: Database.Database,
  name: string
): { id: number; name: string; source: string | null } {
  const habit = db
    .prepare(
      "SELECT id, name, source FROM habits WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL"
    )
    .get(name.trim()) as { id: number; name: string; source: string | null } | undefined;
  if (!habit) {
    const names = (
      db.prepare("SELECT name FROM habits WHERE deleted_at IS NULL ORDER BY name").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .join(", ");
    throw new Error(
      `No habit named "${name}". Existing habits: ${names || "(none — create one on the Habits page first)"}`
    );
  }
  return habit;
}
