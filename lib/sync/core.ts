import { randomUUID } from "crypto";
import type { PullRow, PushRow, SyncTableSpec } from "./tables";

// Pure sync engine: backfill, serialization, and the upsert/conflict rules
// for both sides of the wire. No db/network imports (structural DbLike, like
// lib/network-log-core.ts) so `node --test` exercises it against an
// in-memory sqlite. The role-aware glue lives in lib/sync/client.ts and the
// /api/sync routes.
//
// Conflict model, in one paragraph: every synced row carries a host-assigned
// updated_at. The host stamps rows with its own clock at receipt time, so
// "which write is newer" is decided by ONE clock — receipt order at the
// host — never by device clocks (which drift). Clients adopt the host stamp
// for their own rows from the push response, so a client's clean rows only
// ever hold host timestamps; a locally-modified row is marked sync_dirty and
// wins locally until its push lands, at which point the host's receipt order
// decides globally. Deletes propagate as TOMBSTONES (deleted_at, a spec
// column like any other): a delete is just the newest write happening to be
// a delete, resolved by the same host-stamp rules — nothing in this engine
// special-cases it. The one hard-delete exception (manual-habit cascade)
// lives in lib/tracker-delete.ts, documented there.

export type DbLike = {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
};

type LocalRow = Record<string, string | number | null>;

function nowIso(): string {
  return new Date().toISOString();
}

// ---- outbound: what a device sends ------------------------------------------

// Assign sync identity to rows that predate sync or were just written by an
// app path (which never sets sync_id). Runs before every push/pull-serve.
export function backfillSyncIds(db: DbLike, spec: SyncTableSpec, deviceId: string): number {
  // Row identity is `id` for almost every table; a couple (category_budgets,
  // category_overrides) use a TEXT primary key instead, declared via spec.pk.
  const pk = spec.pk ?? "id";
  const rows = db
    .prepare(`SELECT ${pk} AS pk FROM ${spec.table} WHERE sync_id IS NULL`)
    .all() as Array<{ pk: number | string }>;
  const stamp = db.prepare(
    `UPDATE ${spec.table} SET sync_id = ?, origin_device_id = ?,
       updated_at = COALESCE(updated_at, ?) WHERE ${pk} = ?`
  );
  for (const row of rows) stamp.run(randomUUID(), deviceId, nowIso(), row.pk);
  return rows.length;
}

// Serialize one local row into wire `data`, applying the FK→sync_id swap.
// Returns null when the referenced row has no sync_id yet (it will next tick).
function toWireData(db: DbLike, spec: SyncTableSpec, row: LocalRow): LocalRow | null {
  const data: LocalRow = {};
  for (const col of spec.columns) data[col] = row[col] ?? null;
  const fk = spec.fkToSyncId;
  if (fk) {
    const ref = db
      .prepare(`SELECT sync_id FROM ${fk.refTable} WHERE id = ?`)
      .get(row[fk.localColumn]) as { sync_id: string | null } | undefined;
    if (!ref?.sync_id) return null;
    delete data[fk.localColumn];
    data[fk.payloadKey] = ref.sync_id;
  }
  return data;
}

// Dirty rows, serialized for POST /api/sync/push.
export function collectPending(
  db: DbLike,
  spec: SyncTableSpec,
  deviceId: string,
  limit = 500
): PushRow[] {
  backfillSyncIds(db, spec, deviceId);
  const rows = db
    .prepare(`SELECT * FROM ${spec.table} WHERE sync_dirty = 1 LIMIT ?`)
    .all(limit) as LocalRow[];
  const out: PushRow[] = [];
  for (const row of rows) {
    const data = toWireData(db, spec, row);
    if (data === null) continue; // FK ref not stamped yet — stays dirty, retries
    out.push({
      sync_id: String(row.sync_id),
      origin_device_id: String(row.origin_device_id ?? deviceId),
      data,
    });
  }
  return out;
}

// After the host confirms a push, adopt its stamps and mark the rows clean.
// (Adopting the host timestamp is what makes later pull comparisons
// host-clock vs host-clock — see the conflict model above.)
export function markPushed(
  db: DbLike,
  spec: SyncTableSpec,
  stamped: Array<{ sync_id: string; updated_at: string }>
): void {
  const clear = db.prepare(
    `UPDATE ${spec.table} SET sync_dirty = 0, updated_at = ? WHERE sync_id = ?`
  );
  for (const s of stamped) clear.run(s.updated_at, s.sync_id);
}

// ---- inbound: applying wire rows ---------------------------------------------

// Resolve incoming wire data to local column values. Returns null when the
// FK target hasn't synced here yet (caller counts it and holds the cursor).
function toLocalData(db: DbLike, spec: SyncTableSpec, data: LocalRow): LocalRow | null {
  const local: LocalRow = {};
  for (const col of spec.columns) {
    if (spec.fkToSyncId && col === spec.fkToSyncId.localColumn) continue;
    local[col] = data[col] ?? null;
  }
  const fk = spec.fkToSyncId;
  if (fk) {
    const ref = db
      .prepare(`SELECT id FROM ${fk.refTable} WHERE sync_id = ?`)
      .get(data[fk.payloadKey]) as { id: number } | undefined;
    if (!ref) return null;
    local[fk.localColumn] = ref.id;
  }
  return local;
}

// Find the local row an incoming row corresponds to: by sync_id first, else
// by natural key (two devices logged the same day independently) — the
// natural-key match "adopts" the incoming sync_id instead of violating the
// table's UNIQUE constraint with a duplicate insert.
type LocalMatch = { pk: number | string; updated_at: string | null; sync_dirty: number };

function findLocal(
  db: DbLike,
  spec: SyncTableSpec,
  syncId: string,
  local: LocalRow
): LocalMatch | undefined {
  const pk = spec.pk ?? "id";
  const bySyncId = db
    .prepare(`SELECT ${pk} AS pk, updated_at, sync_dirty FROM ${spec.table} WHERE sync_id = ?`)
    .get(syncId) as LocalMatch | undefined;
  if (bySyncId || !spec.naturalKey) return bySyncId;
  const where = spec.naturalKey
    .map((c) =>
      spec.naturalKeyNoCase ? `LOWER(TRIM(${c})) IS LOWER(TRIM(?))` : `${c} IS ?`
    )
    .join(" AND ");
  return db
    .prepare(`SELECT ${pk} AS pk, updated_at, sync_dirty FROM ${spec.table} WHERE ${where}`)
    .get(...spec.naturalKey.map((c) => local[c])) as LocalMatch | undefined;
}

function upsert(
  db: DbLike,
  spec: SyncTableSpec,
  syncId: string,
  origin: string,
  local: LocalRow,
  updatedAt: string,
  existingPk: number | string | undefined
): void {
  const pk = spec.pk ?? "id";
  const cols = Object.keys(local); // registered spec columns only — never request input
  if (existingPk != null) {
    const sets = cols.map((c) => `${c} = ?`).join(", ");
    db.prepare(
      `UPDATE ${spec.table} SET ${sets}, sync_id = ?, origin_device_id = ?,
         updated_at = ?, sync_dirty = 0 WHERE ${pk} = ?`
    ).run(...cols.map((c) => local[c]), syncId, origin, updatedAt, existingPk);
  } else {
    const names = [...cols, "sync_id", "origin_device_id", "updated_at", "sync_dirty"];
    db.prepare(
      `INSERT INTO ${spec.table} (${names.join(", ")})
       VALUES (${names.map(() => "?").join(", ")})`
    ).run(...cols.map((c) => local[c]), syncId, origin, updatedAt, 0);
  }
}

// HOST side of POST /api/sync/push: upsert each row and stamp it with the
// host's clock at receipt. Receipt order IS the conflict order — the last
// push to reach the host wins, deterministically, regardless of what any
// device's clock said. Returns the stamps so the client can adopt them.
export function applyPush(
  db: DbLike,
  spec: SyncTableSpec,
  rows: PushRow[],
  hostStamp: string
): { stamped: Array<{ sync_id: string; updated_at: string }>; fkMissing: number } {
  const stamped: Array<{ sync_id: string; updated_at: string }> = [];
  let fkMissing = 0;
  for (const row of rows) {
    const local = toLocalData(db, spec, row.data);
    if (local === null) {
      fkMissing++;
      continue;
    }
    const existing = findLocal(db, spec, row.sync_id, local);
    upsert(db, spec, row.sync_id, row.origin_device_id, local, hostStamp, existing?.pk);
    stamped.push({ sync_id: row.sync_id, updated_at: hostStamp });
  }
  return { stamped, fkMissing };
}

// CLIENT side of GET /api/sync/pull: apply rows pulled from the host.
//   - locally-dirty rows are never overwritten (the local edit pushes next
//     tick and the host's receipt order settles it globally);
//   - otherwise the incoming row applies only if its host stamp is newer
//     than the local one (both are host stamps for clean rows).
export function applyPull(
  db: DbLike,
  spec: SyncTableSpec,
  rows: PullRow[]
): { applied: number; skipped: number; fkMissing: number } {
  let applied = 0;
  let skipped = 0;
  let fkMissing = 0;
  for (const row of rows) {
    const local = toLocalData(db, spec, row.data);
    if (local === null) {
      fkMissing++;
      continue;
    }
    const existing = findLocal(db, spec, row.sync_id, local);
    if (existing && existing.sync_dirty === 1) {
      skipped++;
      continue;
    }
    if (existing && existing.updated_at != null && row.updated_at <= existing.updated_at) {
      skipped++;
      continue;
    }
    upsert(db, spec, row.sync_id, row.origin_device_id, local, row.updated_at, existing?.pk);
    applied++;
  }
  return { applied, skipped, fkMissing };
}

// HOST side of GET /api/sync/pull: serve rows newer than the cursor. The
// host's own rows are backfilled lazily here (the host has no push worker —
// anyone pulling sees its live table directly).
export function serializePullRows(
  db: DbLike,
  spec: SyncTableSpec,
  hostDeviceId: string,
  since: string | undefined,
  limit = 1000
): { rows: PullRow[]; cursor: string | null } {
  backfillSyncIds(db, spec, hostDeviceId);
  const raw = (
    since
      ? db
          .prepare(
            `SELECT * FROM ${spec.table} WHERE sync_id IS NOT NULL AND updated_at > ?
             ORDER BY updated_at LIMIT ?`
          )
          .all(since, limit)
      : db
          .prepare(
            `SELECT * FROM ${spec.table} WHERE sync_id IS NOT NULL ORDER BY updated_at LIMIT ?`
          )
          .all(limit)
  ) as LocalRow[];
  const rows: PullRow[] = [];
  for (const row of raw) {
    const data = toWireData(db, spec, row);
    if (data === null) continue;
    rows.push({
      sync_id: String(row.sync_id),
      origin_device_id: String(row.origin_device_id ?? "unknown"),
      updated_at: String(row.updated_at),
      data,
    });
  }
  return { rows, cursor: rows.length > 0 ? rows[rows.length - 1].updated_at : null };
}

// Host stamps must be strictly increasing even when two pushes land in the
// same millisecond — otherwise a pull cursor sitting exactly on the shared
// timestamp would skip the second batch forever.
export function createStamper(now: () => Date = () => new Date()): () => string {
  let last = "";
  return () => {
    let stamp = now().toISOString();
    if (stamp <= last) {
      stamp = new Date(Date.parse(last) + 1).toISOString();
    }
    last = stamp;
    return stamp;
  };
}
