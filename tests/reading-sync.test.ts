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
import { tombstone } from "../lib/sync/tombstone.ts";

// §3: reading list joins the sync allowlist — same shape as applications
// (natural-key merge on title+kind, status-change conflicts, tombstones).

const SYNC_COLS = `sync_id TEXT, updated_at TEXT, origin_device_id TEXT,
  sync_dirty INTEGER NOT NULL DEFAULT 1, deleted_at TEXT`;

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE reading (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'book',
    title TEXT NOT NULL, author TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    link TEXT, notes TEXT, note_path TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ${SYNC_COLS})`);
  for (const sql of syncTriggerSql()) {
    if (/ON reading[\s(]/.test(sql)) db.exec(sql);
  }
  return db;
}

const spec = getSyncSpec("reading")!;

test("reading is allowlisted with title+kind natural key (author excluded — documented)", () => {
  assert.ok(spec);
  assert.deepEqual(spec.naturalKey, ["title", "kind"]);
  assert.equal(spec.naturalKeyNoCase, true);
  for (const col of ["kind", "title", "author", "status", "note_path", "deleted_at"]) {
    assert.ok(spec.columns.includes(col), `syncs ${col}`);
  }
});

test("same title+kind entered on two devices merges; different kind stays separate", () => {
  const a = freshDb();
  const b = freshDb();
  const host = freshDb();
  const stamp = createStamper();

  a.prepare("INSERT INTO reading (title, kind) VALUES ('SICP', 'book')").run();
  b.prepare("INSERT INTO reading (title, kind) VALUES (' sicp ', 'book')").run();
  b.prepare("INSERT INTO reading (title, kind) VALUES ('SICP', 'video')").run();

  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  markPushed(b, spec, applyPush(host, spec, collectPending(b, spec, "dev-b"), stamp()).stamped);

  const rows = host.prepare("SELECT title, kind FROM reading ORDER BY kind").all() as Array<{
    title: string;
    kind: string;
  }>;
  assert.equal(rows.length, 2, "book merged, video separate");
  assert.deepEqual(rows.map((r) => r.kind), ["book", "video"]);
});

test("status change (queued → reading → done) propagates; last write wins", () => {
  const a = freshDb();
  const host = freshDb();
  const b = freshDb();
  const stamp = createStamper();

  a.prepare("INSERT INTO reading (title) VALUES ('Dune')").run();
  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  applyPull(b, spec, serializePullRows(host, spec, "host", undefined).rows);

  a.prepare("UPDATE reading SET status = 'reading'").run();
  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  b.prepare("UPDATE reading SET status = 'done'").run();
  markPushed(b, spec, applyPush(host, spec, collectPending(b, spec, "dev-b"), stamp()).stamped);

  assert.equal(
    (host.prepare("SELECT status FROM reading").get() as { status: string }).status,
    "done",
    "later write to the host wins"
  );
});

test("removing an item tombstones and disappears on the other device after sync", () => {
  const a = freshDb();
  const host = freshDb();
  const b = freshDb();
  const stamp = createStamper();

  a.prepare("INSERT INTO reading (title) VALUES ('Old Course')").run();
  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  const first = serializePullRows(host, spec, "host", undefined);
  applyPull(b, spec, first.rows);

  tombstone(a, "reading", "title = 'Old Course'", []);
  markPushed(a, spec, applyPush(host, spec, collectPending(a, spec, "dev-a"), stamp()).stamped);
  applyPull(b, spec, serializePullRows(host, spec, "host", first.cursor ?? undefined).rows);

  assert.equal(
    (b.prepare("SELECT COUNT(*) AS n FROM reading WHERE deleted_at IS NULL").get() as { n: number }).n,
    0,
    "removal propagated to B"
  );
});
