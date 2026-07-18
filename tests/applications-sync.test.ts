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
import { getSyncSpec, pushBodySchema, syncTriggerSql } from "../lib/sync/tables.ts";
import { tombstone } from "../lib/sync/tombstone.ts";

// §2: applications joins the sync allowlist — natural-key merge
// (company+role, case-insensitive/trimmed), stage-change conflicts, and
// tombstoned removals, all through the same pure core as every other table.

const SYNC_COLS = `sync_id TEXT, updated_at TEXT, origin_device_id TEXT,
  sync_dirty INTEGER NOT NULL DEFAULT 1, deleted_at TEXT`;

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL, role TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'applied',
    next_action TEXT, next_action_at TEXT, contact TEXT, link TEXT, notes TEXT,
    date_applied TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ${SYNC_COLS})`);
  for (const sql of syncTriggerSql()) {
    if (/ON applications[\s(]/.test(sql)) db.exec(sql);
  }
  return db;
}

const spec = getSyncSpec("applications")!;

test("applications is allowlisted and syncs its full column set + deleted_at", () => {
  assert.ok(spec, "applications has a sync spec");
  for (const col of ["company", "role", "stage", "date_applied", "deleted_at"]) {
    assert.ok(spec.columns.includes(col), `syncs ${col}`);
  }
  const parsed = pushBodySchema.safeParse({
    table: "applications",
    rows: [
      {
        sync_id: "6f2b6a2e-9d4e-4a10-8b62-2f6f4b1b7f6a",
        origin_device_id: "laptop",
        data: { company: "Acme", role: "SWE", stage: "applied" },
      },
    ],
  });
  assert.equal(parsed.success, true, "push schema accepts applications");
});

test("same application entered on two devices merges by company+role, case-insensitively", () => {
  const a = freshDb();
  const b = freshDb();
  const host = freshDb();
  const stamp = createStamper();

  a.prepare("INSERT INTO applications (company, role) VALUES ('Acme', 'SWE')").run();
  b.prepare("INSERT INTO applications (company, role) VALUES (' acme ', 'swe')").run();

  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  markPushed(b, spec, applyPush(host, spec, collectPending(b, spec, "dev-b"), stamp()).stamped);

  const rows = host.prepare("SELECT company, sync_id FROM applications").all() as Array<{
    company: string;
    sync_id: string;
  }>;
  assert.equal(rows.length, 1, "one merged row, not a duplicate");
  // The later push adopted the earlier row (kept one identity).
  assert.ok(rows[0].sync_id, "merged row has a sync identity");
});

test("stage change: last write to reach the host wins", () => {
  const a = freshDb();
  const host = freshDb();
  const b = freshDb();
  const stamp = createStamper();

  a.prepare("INSERT INTO applications (company, role, stage) VALUES ('Acme', 'SWE', 'applied')").run();
  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  let pull = serializePullRows(host, spec, "host", undefined);
  applyPull(b, spec, pull.rows);

  // A advances to interview; B advances to screening; B's push lands later.
  a.prepare("UPDATE applications SET stage = 'interview'").run();
  b.prepare("UPDATE applications SET stage = 'screening'").run();
  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  markPushed(b, spec, applyPush(host, spec, collectPending(b, spec, "dev-b"), stamp()).stamped);

  const onHost = host.prepare("SELECT stage FROM applications").get() as { stage: string };
  assert.equal(onHost.stage, "screening", "the write that reached the host last wins");

  // And the settled state pulls back to A (clean after its push).
  pull = serializePullRows(host, spec, "host", undefined);
  applyPull(a, spec, pull.rows);
  const onA = a.prepare("SELECT stage FROM applications").get() as { stage: string };
  assert.equal(onA.stage, "screening");
});

test("removing an application on one device hides it on the other after sync", () => {
  const a = freshDb();
  const host = freshDb();
  const b = freshDb();
  const stamp = createStamper();

  a.prepare("INSERT INTO applications (company, role) VALUES ('Globex', 'PM')").run();
  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  const first = serializePullRows(host, spec, "host", undefined);
  applyPull(b, spec, first.rows);
  assert.equal(
    (b.prepare("SELECT COUNT(*) AS n FROM applications WHERE deleted_at IS NULL").get() as { n: number }).n,
    1
  );

  tombstone(a, "applications", "company = 'Globex'", []);
  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  const second = serializePullRows(host, spec, "host", first.cursor ?? undefined);
  applyPull(b, spec, second.rows);

  assert.equal(
    (b.prepare("SELECT COUNT(*) AS n FROM applications WHERE deleted_at IS NULL").get() as { n: number }).n,
    0,
    "removal propagated"
  );
  assert.equal(
    (b.prepare("SELECT COUNT(*) AS n FROM applications").get() as { n: number }).n,
    1,
    "as a tombstone, not a vanished row"
  );
});
