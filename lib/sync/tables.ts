import { z } from "zod";

// ============================================================================
// THE SYNC ALLOWLIST — the one place that decides what can leave this machine.
//
// NON-NEGOTIABLE RULE: only tables listed in SYNC_TABLES below ever sync.
// Everything else is local-only, permanently and by construction: the push
// and pull endpoints validate the requested table name against this list
// (z.enum below) and reject anything else with a clear error. In particular,
// these must NEVER be added here:
//
//   - transactions, statements   (raw bank data)
//   - mail_accounts, mail_messages (mail content)
//   - oauth_tokens               (live credentials)
//   - agent_log, search_embeddings, calendar_cache, accounts, people,
//     nutrition_logs, health_logs, ... — anything not explicitly reviewed.
//
// Only derived/aggregated tracker data syncs. tests/sync-core.test.ts
// asserts the excluded tables are rejected even when explicitly requested.
// ============================================================================

// Per-table sync spec. `columns` is the exact payload column set (a column
// whitelist — SQL is only ever built from these registered names, never from
// request input). `naturalKey` is the logical identity used when two devices
// created the same thing independently (e.g. both logged gym for the same
// date): a natural-key match adopts the incoming sync_id instead of hitting
// the UNIQUE constraint. `fkToSyncId` handles habit_logs.habit_id, which is
// a device-local autoincrement id: the payload carries the habit's sync_id
// instead, resolved back to the local id on apply.
export type SyncTableSpec = {
  table: string;
  columns: string[];
  naturalKey?: string[];
  fkToSyncId?: { localColumn: string; refTable: string; payloadKey: string };
};

// Order matters: habits must sync before habit_logs so the FK resolves.
export const SYNC_TABLES: SyncTableSpec[] = [
  {
    // The unified Tracker model (Part E folded Goals in): `source` links a
    // tracker to a built-in feed (null = manual habit), `target` is the numeric
    // goal that used to live in the now-legacy `goals` table (no longer synced).
    table: "habits",
    columns: ["name", "cadence", "goal", "source", "target"],
    naturalKey: ["name"],
  },
  {
    table: "habit_logs",
    columns: ["habit_id", "date"],
    naturalKey: ["habit_id", "date"],
    fkToSyncId: { localColumn: "habit_id", refTable: "habits", payloadKey: "habit_sync_id" },
  },
  {
    table: "tasks",
    columns: ["title", "due_at", "priority", "status", "source", "created_at"],
  },
  {
    table: "gym_logs",
    columns: ["date", "notes"],
    naturalKey: ["date"],
  },
  {
    table: "leetcode_stats",
    columns: ["date", "total_solved", "streak", "recent"],
    naturalKey: ["date"],
  },
  {
    table: "networth_snapshots",
    columns: ["date", "accounts_total", "holdings_value", "total"],
    naturalKey: ["date"],
  },
];

export const SYNC_TABLE_NAMES = SYNC_TABLES.map((t) => t.table) as [string, ...string[]];

export function getSyncSpec(table: string): SyncTableSpec | undefined {
  return SYNC_TABLES.find((t) => t.table === table);
}

// ---- wire schemas (zod at the boundary; both endpoints use these) ----------

const rowDataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

export const pushRowSchema = z.object({
  sync_id: z.uuid(),
  origin_device_id: z.string().min(1).max(100),
  data: rowDataSchema,
});

export const pushBodySchema = z.object({
  // z.enum over the allowlist: a non-allowlisted table fails validation —
  // it is impossible to even name another table through this endpoint.
  table: z.enum(SYNC_TABLE_NAMES),
  rows: z.array(pushRowSchema).min(1).max(1000),
});

export const pullQuerySchema = z.object({
  table: z.enum(SYNC_TABLE_NAMES),
  since: z.string().max(40).optional(), // ISO cursor; absent = everything
});

export const pullRowSchema = pushRowSchema.extend({ updated_at: z.string() });

export type PushRow = z.infer<typeof pushRowSchema>;
export type PullRow = z.infer<typeof pullRowSchema>;

// ---- schema DDL, generated from the allowlist -------------------------------
// (Consumed by lib/db.ts so the allowlist literally drives the migration:
// adding a table to SYNC_TABLES is what gives it sync columns + triggers.)

// Sync bookkeeping columns added to every allowlisted table:
//   sync_id          cross-device row identity (UUID; local id stays internal)
//   updated_at       ordering timestamp — HOST-assigned once synced; local
//                    clock only until first push (devices drift, so conflict
//                    resolution keys off host stamps exclusively)
//   origin_device_id which device created the row
//   sync_dirty       1 = has local changes the host hasn't confirmed
export function syncColumnMigrations(): Array<{ table: string; column: string; ddl: string }> {
  return SYNC_TABLES.flatMap(({ table }) => [
    { table, column: "sync_id", ddl: "sync_id TEXT" },
    { table, column: "updated_at", ddl: "updated_at TEXT" },
    { table, column: "origin_device_id", ddl: "origin_device_id TEXT" },
    { table, column: "sync_dirty", ddl: "sync_dirty INTEGER NOT NULL DEFAULT 1" },
  ]);
}

// Triggers keep sync bookkeeping correct WITHOUT touching any existing write
// path (sync is additive):
//   - AFTER INSERT stamps updated_at with the local clock when the writer
//     didn't provide one (app inserts). Sync-applied inserts provide it.
//   - AFTER UPDATE marks the row dirty + bumps updated_at, but ONLY when the
//     update changed neither updated_at nor sync_dirty — i.e. it was a normal
//     app write. Sync operations always set one of those two columns, so they
//     never re-mark rows dirty. (SQLite recursive_triggers is off by default,
//     so the trigger's own UPDATE can't re-fire it.)
export function syncTriggerSql(): string[] {
  const now = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  return SYNC_TABLES.flatMap(({ table }) => [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_sync_id ON ${table}(sync_id)`,
    `CREATE TRIGGER IF NOT EXISTS trg_${table}_sync_insert
     AFTER INSERT ON ${table}
     WHEN NEW.updated_at IS NULL
     BEGIN
       UPDATE ${table} SET updated_at = ${now} WHERE id = NEW.id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_${table}_sync_update
     AFTER UPDATE ON ${table}
     WHEN NEW.updated_at IS OLD.updated_at AND NEW.sync_dirty = OLD.sync_dirty
     BEGIN
       UPDATE ${table} SET sync_dirty = 1, updated_at = ${now} WHERE id = NEW.id;
     END`,
  ]);
}
