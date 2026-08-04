import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { applyPush, backfillSyncIds, collectPending } from "../lib/sync/core.ts";
import {
  HARD_EXCLUDED_TABLES,
  TOGGLEABLE_CATEGORY_IDS,
  getSyncSpec,
} from "../lib/sync/tables.ts";
import {
  applyBulkSyncAction,
  readEnabledSyncTables,
  readSyncConfig,
  seedSyncConfig,
  setSyncEnabled,
} from "../lib/sync/config.ts";

// In-memory sqlite; exercises the Sync Control Center config layer + the two
// riskiest new sync mechanics (content natural keys, non-`id` primary key).

const SYNC_COLS = `sync_id TEXT, updated_at TEXT, origin_device_id TEXT,
  sync_dirty INTEGER NOT NULL DEFAULT 1, deleted_at TEXT`;

function dbWithSyncConfig(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE sync_config (table_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`
  );
  return db;
}

// ---- seeding + toggle behavior ----------------------------------------------

test("seedSyncConfig enables today's allowlist and leaves new categories off", () => {
  const db = dbWithSyncConfig();
  seedSyncConfig(db);
  const cfg = readSyncConfig(db);
  // Currently-syncing categories default on…
  assert.equal(cfg.get("tasks"), true);
  assert.equal(cfg.get("holdings"), true);
  // …newly-added ones default off (an upgrade changes nobody's behavior).
  assert.equal(cfg.get("transactions"), false);
  assert.equal(cfg.get("category-budgets"), false);
  assert.equal(cfg.get("nutrition"), false);
  // Hard-excluded categories get no config row at all.
  assert.equal(cfg.get("oauth-tokens"), undefined);
});

test("seedSyncConfig is idempotent — a later user toggle survives reboot", () => {
  const db = dbWithSyncConfig();
  seedSyncConfig(db);
  setSyncEnabled(db, "transactions", true);
  seedSyncConfig(db); // simulate next boot
  assert.equal(readSyncConfig(db).get("transactions"), true, "user's choice not clobbered");
});

test("toggling a previously-off table on makes it flow; off removes it", () => {
  const db = dbWithSyncConfig();
  seedSyncConfig(db);
  assert.ok(!readEnabledSyncTables(db).has("transactions"), "off by default → not enabled");

  assert.equal(setSyncEnabled(db, "transactions", true), true);
  const on = readEnabledSyncTables(db);
  // The category covers both tables; enabling it enables both.
  assert.ok(on.has("transactions"));
  assert.ok(on.has("statements"));

  // Toggling a valid category off still "succeeds" (returns true); false is
  // reserved for rejected ids.
  assert.equal(setSyncEnabled(db, "transactions", false), true);
});

test("toggling off stops the table flowing (no data touched)", () => {
  const db = dbWithSyncConfig();
  seedSyncConfig(db);
  setSyncEnabled(db, "transactions", true);
  setSyncEnabled(db, "transactions", false);
  const off = readEnabledSyncTables(db);
  assert.ok(!off.has("transactions"));
  assert.ok(!off.has("statements"));
});

// ---- hard-excluded ids can never be enabled ---------------------------------

test("PATCH id enum excludes every hard-excluded category", () => {
  for (const locked of ["oauth-tokens", "device-identity", "sync-bookkeeping", "notes"]) {
    assert.ok(
      !(TOGGLEABLE_CATEGORY_IDS as readonly string[]).includes(locked),
      `${locked} must not be a PATCHable id`
    );
  }
});

test("setSyncEnabled refuses hard-excluded / unknown ids (never a silent success)", () => {
  const db = dbWithSyncConfig();
  seedSyncConfig(db);
  assert.equal(setSyncEnabled(db, "oauth-tokens", true), false);
  assert.equal(setSyncEnabled(db, "device-identity", true), false);
  assert.equal(setSyncEnabled(db, "not-a-real-id", true), false);
  // And nothing hard-excluded ever appears in the effective set.
  const enabled = readEnabledSyncTables(db);
  for (const t of HARD_EXCLUDED_TABLES) assert.ok(!enabled.has(t));
});

test("a stray enabled row for a hard-excluded category still yields nothing", () => {
  const db = dbWithSyncConfig();
  // Directly force an enabled row past the setter (defense-in-depth check).
  db.prepare(
    "INSERT INTO sync_config (table_id, enabled, updated_at) VALUES ('sync-bookkeeping', 1, 'x')"
  ).run();
  const enabled = readEnabledSyncTables(db);
  for (const t of HARD_EXCLUDED_TABLES) assert.ok(!enabled.has(t), `${t} must never flow`);
});

// ---- bulk actions ------------------------------------------------------------

test("bulk actions only ever move toggleable categories", () => {
  const db = dbWithSyncConfig();
  seedSyncConfig(db);
  applyBulkSyncAction(db, "enable");
  let cfg = readSyncConfig(db);
  for (const id of TOGGLEABLE_CATEGORY_IDS) assert.equal(cfg.get(id), true);
  assert.equal(cfg.get("oauth-tokens"), undefined, "hard-excluded untouched");

  applyBulkSyncAction(db, "disable");
  cfg = readSyncConfig(db);
  for (const id of TOGGLEABLE_CATEGORY_IDS) assert.equal(cfg.get(id), false);

  applyBulkSyncAction(db, "reset");
  cfg = readSyncConfig(db);
  assert.equal(cfg.get("tasks"), true, "reset restores shipped defaults");
  assert.equal(cfg.get("transactions"), false);
});

// ---- §6: content natural key dedupes transactions/nutrition -----------------

test("nutrition logs merge on date+item+source instead of duplicating", () => {
  const spec = getSyncSpec("nutrition_logs")!;
  const host = new Database(":memory:");
  host.exec(`CREATE TABLE nutrition_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, item TEXT NOT NULL,
    calories INTEGER NOT NULL, protein INTEGER NOT NULL, carbs INTEGER NOT NULL,
    fat INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'text',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ${SYNC_COLS})`);
  host.prepare(
    "INSERT INTO nutrition_logs (date, item, calories, protein, carbs, fat, source) VALUES ('2026-07-20','Oatmeal',300,10,50,5,'text')"
  ).run();
  backfillSyncIds(host, spec, "host");

  // A different device logged the same meal (different casing/whitespace).
  applyPush(
    host,
    spec,
    [
      {
        sync_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        origin_device_id: "phone",
        data: { date: "2026-07-20", item: " oatmeal ", calories: 320, protein: 11, carbs: 52, fat: 6, source: "text", created_at: "2026-07-20" },
      },
    ],
    "2026-07-21T00:00:00.000Z"
  );

  const rows = host.prepare("SELECT * FROM nutrition_logs").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1, "same meal merged, not duplicated");
  assert.equal(rows[0].calories, 320, "incoming write won by host stamp");
});

// ---- non-`id` primary key (category_budgets) round-trips --------------------

test("category_budgets (TEXT pk) backfills, collects, and upserts by its pk", () => {
  const spec = getSyncSpec("category_budgets")!;
  assert.equal(spec.pk, "category");
  const host = new Database(":memory:");
  host.exec(`CREATE TABLE category_budgets (
    category TEXT PRIMARY KEY, monthly_limit REAL NOT NULL, ${SYNC_COLS})`);
  host.prepare("INSERT INTO category_budgets (category, monthly_limit) VALUES ('Groceries', 400)").run();

  // backfill keys off the TEXT pk, not a missing `id` column.
  const n = backfillSyncIds(host, spec, "host");
  assert.equal(n, 1);
  const pending = collectPending(host, spec, "host");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].data.category, "Groceries");
  assert.ok(!("id" in pending[0].data));

  // Another device changes the same category's limit → merges by pk, no dup.
  applyPush(
    host,
    spec,
    [
      {
        sync_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        origin_device_id: "phone",
        data: { category: "Groceries", monthly_limit: 500 },
      },
    ],
    "2026-07-21T00:00:00.000Z"
  );
  const rows = host.prepare("SELECT * FROM category_budgets").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1, "same category merged by pk");
  assert.equal(rows[0].monthly_limit, 500);
});
