import { randomUUID } from "crypto";
import type { DbLike } from "../sync/core";

// Pure core of the brokerage holdings import (relative imports only, so
// node --test can load it against an in-memory db — lib/sync/core.ts
// pattern). A POSITIONS statement is a full snapshot of the account, so
// `replace` mode is "tombstone the missing, upsert the named" in ONE
// transaction: a sold position gets a §1 tombstone that propagates to
// other devices instead of lingering (or, pre-tombstones, being hard
// DELETE-d and resurrected by the next pull). A `history` export is a
// partial activity log — upsert only, nothing tombstoned.
//
// Every row this import touches — upserts AND tombstones — is stamped with
// the same import_batch_id (one UUID per call): not needed for conflict
// resolution (updated_at + ticker natural key handle that), but it answers
// "which import did this" without inferring from timestamps.
//
// KNOWN, ACCEPTED LIMITATION (documented in lib/sync/tables.ts): two
// devices importing DIFFERENT statements before syncing merge per-row
// (last write to reach the host wins per ticker), so the result may match
// neither statement exactly. tests/holdings-sync.test.ts pins the current
// behavior so a change here is noticed, not silent.

export type ImportableHolding = { ticker: string; shares: number; cost_basis: number };

export function importHoldingsCore(
  db: DbLike,
  holdings: ImportableHolding[],
  replace: boolean,
  batchId: string = randomUUID()
): { upserted: number; tombstoned: number; batchId: string } {
  const now = new Date().toISOString();
  let tombstoned = 0;

  if (replace) {
    // Tombstone every live holding the new statement doesn't mention.
    // Bookkeeping set explicitly, same as lib/sync/tombstone.ts.
    const named = holdings.map((h) => h.ticker.toUpperCase());
    const notIn = named.length > 0 ? `AND UPPER(ticker) NOT IN (${named.map(() => "?").join(",")})` : "";
    const info = db
      .prepare(
        `UPDATE holdings SET deleted_at = ?, sync_dirty = 1, updated_at = ?,
           import_batch_id = ?
         WHERE deleted_at IS NULL ${notIn}`
      )
      .run(now, now, batchId, ...named) as { changes: number };
    tombstoned = info.changes;
  }

  const upsert = db.prepare(
    `INSERT INTO holdings (ticker, shares, cost_basis, import_batch_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET
       shares = excluded.shares, cost_basis = excluded.cost_basis,
       import_batch_id = excluded.import_batch_id, deleted_at = NULL`
  );
  for (const h of holdings) upsert.run(h.ticker, h.shares, h.cost_basis, batchId);

  return { upserted: holdings.length, tombstoned, batchId };
}
