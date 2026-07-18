import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  applyPull,
  applyPush,
  collectPending,
  createStamper,
  markPushed,
  serializePullRows,
} from "../lib/sync/core.ts";
import { getSyncSpec, syncTriggerSql } from "../lib/sync/tables.ts";
import { tombstone, undelete } from "../lib/sync/tombstone.ts";
import { completeTaskCore, stillDueToday } from "../lib/tasks/complete.ts";

// §1 delete propagation: a delete is a tombstone (deleted_at) that syncs
// like any other write. All in-memory — a "host" db and two "client" dbs
// wired through the pure core functions, no network.

const SYNC_COLS = `sync_id TEXT, updated_at TEXT, origin_device_id TEXT,
  sync_dirty INTEGER NOT NULL DEFAULT 1, deleted_at TEXT`;

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, due_at TEXT, priority TEXT NOT NULL DEFAULT 'high',
    status TEXT NOT NULL DEFAULT 'open', source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    description TEXT, gcal_event_id TEXT, completed_at TEXT,
    llm_rank INTEGER, llm_rank_source TEXT,
    llm_suggested_priority TEXT, llm_rationale TEXT,
    ${SYNC_COLS})`);
  db.exec(`CREATE TABLE gym_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE, notes TEXT,
    ${SYNC_COLS})`);
  for (const sql of syncTriggerSql()) {
    if (/ON (tasks|gym_logs)[\s(]/.test(sql)) db.exec(sql);
  }
  return db;
}

const tasksSpec = getSyncSpec("tasks")!;
const gymSpec = getSyncSpec("gym_logs")!;

// One push+pull round-trip: client → host, then host → other client.
function syncOver(
  from: InstanceType<typeof Database>,
  host: InstanceType<typeof Database>,
  to: InstanceType<typeof Database>,
  spec: NonNullable<ReturnType<typeof getSyncSpec>>,
  stamp: () => string,
  since?: string
): string | null {
  const pending = collectPending(from, spec, "device-from");
  if (pending.length > 0) {
    const { stamped } = applyPush(host, spec, pending, stamp());
    markPushed(from, spec, stamped);
  }
  const { rows, cursor } = serializePullRows(host, spec, "host", since);
  applyPull(to, spec, rows);
  return cursor;
}

test("deleted_at is a synced column on every allowlisted table", () => {
  for (const table of ["tasks", "gym_logs", "habits", "habit_logs", "leetcode_stats", "networth_snapshots"]) {
    const spec = getSyncSpec(table);
    assert.ok(spec, `${table} has a spec`);
    assert.ok(spec!.columns.includes("deleted_at"), `${table} syncs deleted_at`);
  }
});

test("tombstone marks the row deleted+dirty; undelete reverses; both are guarded no-ops", () => {
  const db = freshDb();
  db.prepare("INSERT INTO gym_logs (date) VALUES ('2026-07-10')").run();
  db.prepare("UPDATE gym_logs SET sync_dirty = 0").run(); // pretend pushed

  assert.equal(tombstone(db, "gym_logs", "date = ?", ["2026-07-10"]), 1);
  const row = db.prepare("SELECT * FROM gym_logs").get() as Record<string, unknown>;
  assert.ok(row.deleted_at, "deleted_at set");
  assert.equal(row.sync_dirty, 1, "marked for push");
  // Already-deleted → no-op (callers keep their 404 handling).
  assert.equal(tombstone(db, "gym_logs", "date = ?", ["2026-07-10"]), 0);

  assert.equal(undelete(db, "gym_logs", "date = ?", ["2026-07-10"]), 1);
  const back = db.prepare("SELECT deleted_at FROM gym_logs").get() as { deleted_at: string | null };
  assert.equal(back.deleted_at, null);
  assert.equal(undelete(db, "gym_logs", "date = ?", ["2026-07-10"]), 0);
});

test("tombstone refuses non-synced tables", () => {
  const db = freshDb();
  assert.throws(() => tombstone(db, "transactions", "id = ?", [1]), /not a synced table/);
  assert.throws(() => undelete(db, "oauth_tokens", "1=1", []), /not a synced table/);
});

test("a delete on device A disappears on device B after a sync round-trip", () => {
  const a = freshDb();
  const host = freshDb();
  const b = freshDb();
  const stamp = createStamper();

  a.prepare("INSERT INTO tasks (title) VALUES ('buy milk')").run();
  const cursor = syncOver(a, host, b, tasksSpec, stamp);
  assert.equal(
    (b.prepare("SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL").get() as { n: number }).n,
    1,
    "task arrived on B"
  );

  tombstone(a, "tasks", "title = 'buy milk'", []);
  syncOver(a, host, b, tasksSpec, stamp, cursor ?? undefined);

  const onB = b.prepare("SELECT deleted_at, sync_dirty FROM tasks").get() as {
    deleted_at: string | null;
    sync_dirty: number;
  };
  assert.ok(onB.deleted_at, "tombstone propagated to B");
  assert.equal(onB.sync_dirty, 0, "pulled tombstone is clean, not re-pushed");
  const onHost = host.prepare("SELECT deleted_at FROM tasks").get() as { deleted_at: string | null };
  assert.ok(onHost.deleted_at, "host has the tombstone");
});

test("a locally-dirty edit is never overwritten by an incoming tombstone", () => {
  const b = freshDb();
  const host = freshDb();
  const stamp = createStamper();

  b.prepare("INSERT INTO tasks (title) VALUES ('draft essay')").run();
  const pending = collectPending(b, tasksSpec, "device-b");
  const { stamped } = applyPush(host, tasksSpec, pending, stamp());
  markPushed(b, tasksSpec, stamped);

  // Host receives a tombstone from elsewhere…
  tombstone(host, "tasks", "title = 'draft essay'", []);
  // …but B edited the row locally in the meantime (dirty again).
  b.prepare("UPDATE tasks SET title = 'draft essay v2' WHERE title = 'draft essay'").run();

  const { rows } = serializePullRows(host, tasksSpec, "host", undefined);
  const { skipped } = applyPull(b, tasksSpec, rows);
  assert.equal(skipped, 1, "dirty local row skipped the incoming tombstone");
  const row = b.prepare("SELECT title, deleted_at FROM tasks").get() as {
    title: string;
    deleted_at: string | null;
  };
  assert.equal(row.title, "draft essay v2");
  assert.equal(row.deleted_at, null, "local edit survives until its own push settles it");
});

test("an edit that reaches the host after a tombstone un-deletes the row (newest write wins)", () => {
  const host = freshDb();
  const stamp = createStamper();
  const a = freshDb();

  a.prepare("INSERT INTO gym_logs (date, notes) VALUES ('2026-07-11', 'legs')").run();
  let pending = collectPending(a, gymSpec, "device-a");
  markPushed(a, gymSpec, applyPush(host, gymSpec, pending, stamp()).stamped);

  tombstone(host, "gym_logs", "date = '2026-07-11'", []);

  // A re-logs the same day (undelete locally, push) — its push reaches the
  // host later, so the live version wins.
  a.prepare("UPDATE gym_logs SET notes = 'legs again' WHERE date = '2026-07-11'").run();
  pending = collectPending(a, gymSpec, "device-a");
  markPushed(a, gymSpec, applyPush(host, gymSpec, pending, stamp()).stamped);

  const onHost = host.prepare("SELECT notes, deleted_at FROM gym_logs").get() as {
    notes: string;
    deleted_at: string | null;
  };
  assert.equal(onHost.deleted_at, null, "later edit un-deleted the row on the host");
  assert.equal(onHost.notes, "legs again");
});

test("read helpers exclude tombstoned rows (spot-check: task completion + due list)", () => {
  const db = freshDb();
  const today = "2026-07-17";
  db.prepare("INSERT INTO tasks (title, due_at) VALUES ('alive', ?)").run(today);
  db.prepare("INSERT INTO tasks (title, due_at) VALUES ('deleted', ?)").run(today);
  tombstone(db, "tasks", "title = 'deleted'", []);

  assert.deepEqual(stillDueToday(db, today), ["alive"], "due list hides the tombstone");
  const deletedId = (
    db.prepare("SELECT id FROM tasks WHERE title = 'deleted'").get() as { id: number }
  ).id;
  assert.deepEqual(completeTaskCore(db, deletedId), { outcome: "not-found" });
});

test("backup/restore keeps tombstones: a restore can never undelete (§1.6)", () => {
  const db = freshDb();
  db.prepare("INSERT INTO gym_logs (date) VALUES ('2026-07-01')").run();
  db.prepare("INSERT INTO gym_logs (date) VALUES ('2026-07-02')").run();
  tombstone(db, "gym_logs", "date = '2026-07-02'", []);

  // Backup = SELECT * (scripts/backup.ts); restore = truncate + reinsert
  // every column present (scripts/restore.ts). Same shape, in miniature.
  const backup = db.prepare("SELECT * FROM gym_logs").all() as Record<string, unknown>[];
  db.prepare("DELETE FROM gym_logs").run();
  const cols = Object.keys(backup[0]);
  const insert = db.prepare(
    `INSERT INTO gym_logs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
  );
  for (const row of backup) insert.run(...cols.map((c) => row[c] ?? null));

  const live = db
    .prepare("SELECT date FROM gym_logs WHERE deleted_at IS NULL")
    .all() as Array<{ date: string }>;
  assert.deepEqual(live.map((r) => r.date), ["2026-07-01"], "tombstone survived the restore");

  // And a pull from a host that also has the tombstone doesn't resurrect it:
  // the incoming row IS the tombstone (deleted_at travels in the payload).
  const host = freshDb();
  const stamp = createStamper();
  const pending = collectPending(db, gymSpec, "device-a");
  applyPush(host, gymSpec, pending, stamp());
  const { rows } = serializePullRows(host, gymSpec, "host", undefined);
  const restored = freshDb();
  applyPull(restored, gymSpec, rows);
  const liveAfterPull = restored
    .prepare("SELECT date FROM gym_logs WHERE deleted_at IS NULL")
    .all() as Array<{ date: string }>;
  assert.deepEqual(liveAfterPull.map((r) => r.date), ["2026-07-01"]);
});
