import type { DbLike } from "./core";
import {
  HARD_EXCLUDED_TABLES,
  SYNC_CATEGORIES,
  getCategory,
  type SyncCategory,
} from "./tables.ts";

// Per-device sync configuration: which categories this machine sends/receives.
// Backed by the local `sync_config` table (itself hard-excluded from sync —
// each device owns its own config, mirroring device_meta). Every function here
// takes an explicit db (structural DbLike) so the pure logic is unit-testable
// against in-memory sqlite, exactly like lib/sync/core.ts. The role-aware glue
// (routes, cron loop) passes getDb().

function nowIso(): string {
  return new Date().toISOString();
}

// Read the raw config rows as a map of category id -> enabled.
export function readSyncConfig(db: DbLike): Map<string, boolean> {
  const rows = db.prepare("SELECT table_id, enabled FROM sync_config").all() as Array<{
    table_id: string;
    enabled: number;
  }>;
  return new Map(rows.map((r) => [r.table_id, r.enabled === 1]));
}

// The effective set of TABLE NAMES this device will sync right now: enabled,
// registered, non-hard-excluded. Hard-excluded tables are subtracted
// unconditionally — even if a stray sync_config row said enabled, they never
// flow. This is the defense-in-depth line the old static allowlist gave us.
export function readEnabledSyncTables(db: DbLike): Set<string> {
  const cfg = readSyncConfig(db);
  const out = new Set<string>();
  for (const cat of SYNC_CATEGORIES) {
    if (cat.hardExcluded) continue;
    if (cfg.get(cat.id) !== true) continue;
    for (const spec of cat.specs) out.add(spec.table);
  }
  for (const t of HARD_EXCLUDED_TABLES) out.delete(t);
  return out;
}

// Cached wrapper for the hot path (push/pull filtering + the cron loop). The
// process has exactly one db, so a small time cache is safe; PATCH invalidates
// it explicitly so a toggle takes effect on the very next tick.
let cache: { at: number; tables: Set<string> } | null = null;
const CACHE_TTL_MS = 5000;

export function getEnabledSyncTables(db: DbLike): Set<string> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.tables;
  const tables = readEnabledSyncTables(db);
  cache = { at: now, tables };
  return tables;
}

export function invalidateSyncConfigCache(): void {
  cache = null;
}

// Seed on migration: every category that ships enabled today gets enabled = 1;
// everything new gets 0. INSERT OR IGNORE keeps it idempotent — a later user
// toggle is never clobbered on a future boot. Hard-excluded categories get no
// row (they are never toggles).
export function seedSyncConfig(db: DbLike): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO sync_config (table_id, enabled, updated_at) VALUES (?, ?, ?)"
  );
  const now = nowIso();
  for (const cat of SYNC_CATEGORIES) {
    if (cat.hardExcluded) continue;
    stmt.run(cat.id, cat.defaultEnabled ? 1 : 0, now);
  }
}

// Write-through toggle. Rejects unknown or hard-excluded ids (the caller has
// already zod-validated the id against TOGGLEABLE_CATEGORY_IDS, but this is the
// last line before the DB write). Returns false if the id isn't a real toggle.
export function setSyncEnabled(db: DbLike, id: string, enabled: boolean): boolean {
  const cat = getCategory(id);
  if (!cat || cat.hardExcluded) return false;
  db.prepare(
    `INSERT INTO sync_config (table_id, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(table_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(id, enabled ? 1 : 0, nowIso());
  invalidateSyncConfigCache();
  return true;
}

// Bulk toolbar actions — only ever touch non-hard-excluded categories.
//   "enable"  -> all on
//   "disable" -> all off
//   "reset"   -> back to the shipped defaults (today's allowlist)
export function applyBulkSyncAction(db: DbLike, action: "enable" | "disable" | "reset"): void {
  const stmt = db.prepare(
    `INSERT INTO sync_config (table_id, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(table_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  );
  const now = nowIso();
  for (const cat of SYNC_CATEGORIES) {
    if (cat.hardExcluded) continue;
    const enabled = action === "enable" ? 1 : action === "disable" ? 0 : cat.defaultEnabled ? 1 : 0;
    stmt.run(cat.id, enabled, now);
  }
  invalidateSyncConfigCache();
}

// Shape returned by GET /api/sync/config for each row the /sync page renders.
export type SyncCategoryView = {
  id: string;
  label: string;
  description: string;
  domain: SyncCategory["domain"];
  hardExcluded: boolean;
  enabled: boolean;
  risk?: string;
  lockedReason?: string;
  tables: string[];
};

// The full registry merged with this device's config, for the page.
export function getSyncConfigView(db: DbLike): SyncCategoryView[] {
  const cfg = readSyncConfig(db);
  return SYNC_CATEGORIES.map((cat) => ({
    id: cat.id,
    label: cat.label,
    description: cat.description,
    domain: cat.domain,
    hardExcluded: cat.hardExcluded,
    // Hard-excluded categories are always effectively off, regardless of any
    // stray config row.
    enabled: cat.hardExcluded ? false : cfg.get(cat.id) === true,
    risk: cat.risk,
    lockedReason: cat.lockedReason,
    tables: cat.specs.map((s) => s.table),
  }));
}
