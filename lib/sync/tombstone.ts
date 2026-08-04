import type { DbLike } from "./core";
// Explicit .ts extension: this is a RUNTIME import and node --test loads
// these modules directly (ESM, no bundler) — extensionless would fail there.
import { SYNC_TABLE_NAMES } from "./tables.ts";

// Tombstone = the ONE way a row on a synced table stops being live: set
// deleted_at, mark it dirty, bump updated_at — the write then propagates
// through sync exactly like an edit (host stamps it at receipt, last write
// to reach the host wins). Hard DELETEs on synced tables are forbidden
// everywhere except the manual-habit cascade (lib/tracker-delete.ts, a
// documented, intentionally-irreversible exception).
//
// Setting sync_dirty/updated_at explicitly (rather than relying on the
// AFTER UPDATE trigger) keeps this correct in trigger-less test databases
// and is deterministic either way: the trigger deliberately skips updates
// that touch either column.
//
// `table` must come from code, never request input — the allowlist assert
// makes a slipped-through raw table name a loud error, not a silent query.

function assertSynced(table: string): void {
  if (!(SYNC_TABLE_NAMES as readonly string[]).includes(table)) {
    throw new Error(`tombstone: "${table}" is not a synced table — use a hard DELETE instead`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// Returns the number of rows tombstoned (0 = nothing matched or already
// deleted — callers keep their existing "nothing to delete" handling).
export function tombstone(
  db: DbLike,
  table: string,
  where: string,
  params: readonly (string | number)[]
): number {
  assertSynced(table);
  const now = nowIso();
  const info = db
    .prepare(
      `UPDATE ${table} SET deleted_at = ?, sync_dirty = 1, updated_at = ?
       WHERE (${where}) AND deleted_at IS NULL`
    )
    .run(now, now, ...params) as { changes: number };
  return info.changes;
}

// Inverse: bring a tombstoned row back (re-log a corrected-away day, re-add
// a same-natural-key item). Same bookkeeping so the undelete propagates too.
export function undelete(
  db: DbLike,
  table: string,
  where: string,
  params: readonly (string | number)[]
): number {
  assertSynced(table);
  const info = db
    .prepare(
      `UPDATE ${table} SET deleted_at = NULL, sync_dirty = 1, updated_at = ?
       WHERE (${where}) AND deleted_at IS NOT NULL`
    )
    .run(nowIso(), ...params) as { changes: number };
  return info.changes;
}
