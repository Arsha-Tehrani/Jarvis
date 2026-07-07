import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  applyPull,
  applyPush,
  backfillSyncIds,
  collectPending,
  createStamper,
  markPushed,
} from "../lib/sync/core.ts";
import {
  SYNC_TABLE_NAMES,
  getSyncSpec,
  pullQuerySchema,
  pushBodySchema,
  syncTriggerSql,
} from "../lib/sync/tables.ts";

// All against in-memory sqlite — no network, no jarvis.db, no two machines.

// ---- THE test: excluded tables can never be requested ----------------------

const FORBIDDEN = [
  "transactions",
  "statements",
  "mail_messages",
  "mail_accounts",
  "oauth_tokens",
  "agent_log",
  "network_log",
  "health_logs",
  "accounts",
];

test("non-allowlisted tables are rejected by the push endpoint schema", () => {
  for (const table of FORBIDDEN) {
    const parsed = pushBodySchema.safeParse({
      table,
      rows: [
        {
          sync_id: "6f2b6a2e-9d4e-4a10-8b62-2f6f4b1b7f6a",
          origin_device_id: "attacker",
          data: { anything: 1 },
        },
      ],
    });
    assert.equal(parsed.success, false, `${table} must be rejected by push`);
  }
});

test("non-allowlisted tables are rejected by the pull endpoint schema", () => {
  for (const table of FORBIDDEN) {
    const parsed = pullQuerySchema.safeParse({ table });
    assert.equal(parsed.success, false, `${table} must be rejected by pull`);
  }
});

test("the allowlist itself contains no raw finance/mail/token tables", () => {
  for (const table of FORBIDDEN) {
    assert.ok(!SYNC_TABLE_NAMES.includes(table), `${table} must never be allowlisted`);
  }
});

// ---- fixtures ---------------------------------------------------------------

const SYNC_COLS = `sync_id TEXT, updated_at TEXT, origin_device_id TEXT,
  sync_dirty INTEGER NOT NULL DEFAULT 1`;

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, due_at TEXT, priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ${SYNC_COLS})`);
  db.exec(`CREATE TABLE gym_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE, notes TEXT,
    ${SYNC_COLS})`);
  db.exec(`CREATE TABLE habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
    cadence TEXT NOT NULL DEFAULT 'daily', goal INTEGER NOT NULL DEFAULT 1,
    ${SYNC_COLS})`);
  db.exec(`CREATE TABLE habit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id INTEGER NOT NULL, date TEXT NOT NULL,
    ${SYNC_COLS},
    UNIQUE(habit_id, date))`);
  // The real triggers from the allowlist file (covers tasks/gym/habits/…).
  for (const sql of syncTriggerSql()) {
    // Only create triggers for tables this fixture defines.
    if (/ON (tasks|gym_logs|habits|habit_logs)[\s(]/.test(sql)) db.exec(sql);
  }
  return db;
}

const tasksSpec = getSyncSpec("tasks")!;
const gymSpec = getSyncSpec("gym_logs")!;
const habitsSpec = getSyncSpec("habits")!;
const habitLogsSpec = getSyncSpec("habit_logs")!;

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// ---- triggers keep bookkeeping without touching app write paths -------------

test("app insert + update mark rows dirty; sync-style writes don't", () => {
  const db = freshDb();
  db.prepare("INSERT INTO tasks (title) VALUES ('call bank')").run();
  let row = db.prepare("SELECT * FROM tasks").get() as Record<string, unknown>;
  assert.equal(row.sync_dirty, 1);
  assert.ok(row.updated_at, "insert trigger stamps updated_at");

  // Simulate a completed push: clean + host stamp.
  db.prepare("UPDATE tasks SET sync_dirty = 0, updated_at = '2026-07-07T00:00:00.000Z'").run();
  row = db.prepare("SELECT * FROM tasks").get() as Record<string, unknown>;
  assert.equal(row.sync_dirty, 0, "sync write must not re-mark dirty");

  // A normal app write (status flip) re-marks dirty and bumps updated_at.
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = 1").run();
  row = db.prepare("SELECT * FROM tasks").get() as Record<string, unknown>;
  assert.equal(row.sync_dirty, 1);
  assert.notEqual(row.updated_at, "2026-07-07T00:00:00.000Z");
});

// ---- outbound: backfill + collect ------------------------------------------

test("collectPending backfills sync identity and serializes dirty rows", () => {
  const db = freshDb();
  db.prepare("INSERT INTO tasks (title) VALUES ('a')").run();
  db.prepare("INSERT INTO tasks (title) VALUES ('b')").run();
  const pending = collectPending(db, tasksSpec, "device-1");
  assert.equal(pending.length, 2);
  for (const row of pending) {
    assert.match(row.sync_id, /^[0-9a-f-]{36}$/);
    assert.equal(row.origin_device_id, "device-1");
    assert.ok("title" in row.data && "status" in row.data);
    assert.ok(!("id" in row.data), "local autoincrement id never goes on the wire");
  }
  // markPushed adopts host stamps and clears dirty → nothing pending after.
  markPushed(db, tasksSpec, pending.map((r) => ({ sync_id: r.sync_id, updated_at: "2026-07-07T10:00:00.000Z" })));
  assert.equal(collectPending(db, tasksSpec, "device-1").length, 0);
});

// ---- host: upsert by sync_id, receipt order wins ----------------------------

test("applyPush upserts by sync_id and the host-timestamped write wins deterministically", () => {
  const host = freshDb();
  const v1 = { sync_id: UUID_A, origin_device_id: "mac", data: { title: "v1", due_at: null, priority: "low", status: "open", source: "agent", created_at: "2026-07-01" } };
  const v2 = { ...v1, data: { ...v1.data, title: "v2", status: "done" } };

  const r1 = applyPush(host, tasksSpec, [v1], "2026-07-07T10:00:00.000Z");
  assert.deepEqual(r1.stamped, [{ sync_id: UUID_A, updated_at: "2026-07-07T10:00:00.000Z" }]);

  // Second push of the SAME sync_id: updated in place (no duplicate), and
  // the later host stamp — receipt order — is what the row carries.
  applyPush(host, tasksSpec, [v2], "2026-07-07T10:05:00.000Z");
  const rows = host.prepare("SELECT * FROM tasks").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "v2");
  assert.equal(rows[0].updated_at, "2026-07-07T10:05:00.000Z");
  assert.equal(rows[0].sync_dirty, 0);
});

test("applyPush adopts natural keys: two devices logging the same gym day merge, no UNIQUE crash", () => {
  const host = freshDb();
  host.prepare("INSERT INTO gym_logs (date, notes) VALUES ('2026-07-06', 'host set')").run();
  backfillSyncIds(host, gymSpec, "host");

  applyPush(host, gymSpec, [
    { sync_id: UUID_B, origin_device_id: "mac", data: { date: "2026-07-06", notes: "mac set" } },
  ], "2026-07-07T10:00:00.000Z");

  const rows = host.prepare("SELECT * FROM gym_logs").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1, "same date merged, not duplicated");
  assert.equal(rows[0].sync_id, UUID_B, "incoming sync_id adopted");
  assert.equal(rows[0].notes, "mac set");
});

// ---- client pull: host stamp comparison + dirty-local protection ------------

function pulledTask(syncId: string, title: string, updatedAt: string) {
  return {
    sync_id: syncId,
    origin_device_id: "other-device",
    updated_at: updatedAt,
    data: { title, due_at: null, priority: "medium", status: "open", source: "manual", created_at: "2026-07-01" },
  };
}

test("applyPull applies newer host stamps, skips older ones", () => {
  const db = freshDb();
  applyPull(db, tasksSpec, [pulledTask(UUID_A, "first", "2026-07-07T10:00:00.000Z")]);
  // Older stamp for the same sync_id → skipped.
  let result = applyPull(db, tasksSpec, [pulledTask(UUID_A, "stale", "2026-07-07T09:00:00.000Z")]);
  assert.deepEqual(result, { applied: 0, skipped: 1, fkMissing: 0 });
  // Newer stamp → applied.
  result = applyPull(db, tasksSpec, [pulledTask(UUID_A, "newer", "2026-07-07T11:00:00.000Z")]);
  assert.equal(result.applied, 1);
  const row = db.prepare("SELECT title, sync_dirty FROM tasks").get() as Record<string, unknown>;
  assert.equal(row.title, "newer");
  assert.equal(row.sync_dirty, 0);
});

test("applyPull never overwrites a locally-dirty row (local edit pushes and wins by receipt order)", () => {
  const db = freshDb();
  applyPull(db, tasksSpec, [pulledTask(UUID_A, "synced", "2026-07-07T10:00:00.000Z")]);
  // Local edit → trigger marks dirty.
  db.prepare("UPDATE tasks SET title = 'my local edit' WHERE sync_id = ?").run(UUID_A);
  const result = applyPull(db, tasksSpec, [pulledTask(UUID_A, "remote edit", "2026-07-07T12:00:00.000Z")]);
  assert.deepEqual(result, { applied: 0, skipped: 1, fkMissing: 0 });
  const row = db.prepare("SELECT title FROM tasks").get() as { title: string };
  assert.equal(row.title, "my local edit");
});

// ---- habit_logs FK travels as the habit's sync_id ----------------------------

test("habit_logs sync by habit sync_id: unresolved FK is held, then applies once the habit lands", () => {
  const db = freshDb();
  const log = {
    sync_id: UUID_A,
    origin_device_id: "mac",
    updated_at: "2026-07-07T10:00:01.000Z",
    data: { habit_sync_id: UUID_B, date: "2026-07-07" },
  };
  // Habit hasn't synced here yet → fkMissing, nothing written.
  let result = applyPull(db, habitLogsSpec, [log]);
  assert.deepEqual(result, { applied: 0, skipped: 0, fkMissing: 1 });

  applyPull(db, habitsSpec, [{
    sync_id: UUID_B,
    origin_device_id: "mac",
    updated_at: "2026-07-07T10:00:00.000Z",
    data: { name: "reading", cadence: "daily", goal: 1 },
  }]);
  result = applyPull(db, habitLogsSpec, [log]);
  assert.equal(result.applied, 1);
  const row = db
    .prepare("SELECT habit_id FROM habit_logs WHERE sync_id = ?")
    .get(UUID_A) as { habit_id: number };
  const habit = db.prepare("SELECT id FROM habits WHERE sync_id = ?").get(UUID_B) as { id: number };
  assert.equal(row.habit_id, habit.id, "payload sync_id resolved to the LOCAL habit id");
});

test("collectPending swaps habit_id for the habit's sync_id on the wire", () => {
  const db = freshDb();
  db.prepare("INSERT INTO habits (name) VALUES ('gym')").run();
  backfillSyncIds(db, habitsSpec, "mac");
  const habit = db.prepare("SELECT id, sync_id FROM habits").get() as { id: number; sync_id: string };
  db.prepare("INSERT INTO habit_logs (habit_id, date) VALUES (?, '2026-07-07')").run(habit.id);

  const pending = collectPending(db, habitLogsSpec, "mac");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].data.habit_sync_id, habit.sync_id);
  assert.ok(!("habit_id" in pending[0].data), "device-local habit_id never goes on the wire");
});

// ---- monotonic host stamps ---------------------------------------------------

test("host stamps are strictly increasing even within one millisecond", () => {
  const fixed = new Date("2026-07-07T10:00:00.000Z");
  const stamp = createStamper(() => fixed);
  const a = stamp();
  const b = stamp();
  const c = stamp();
  assert.ok(a < b && b < c, `expected strictly increasing, got ${a}, ${b}, ${c}`);
});
