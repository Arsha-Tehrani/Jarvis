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
import { importHoldingsCore } from "../lib/finance/holdings-import-core.ts";

// §4: watchlist + holdings sync. The interesting part is the brokerage
// positions import — "tombstone the missing, upsert the named" — and its
// propagation, plus the documented two-device interleave limitation.

const SYNC_COLS = `sync_id TEXT, updated_at TEXT, origin_device_id TEXT,
  sync_dirty INTEGER NOT NULL DEFAULT 1, deleted_at TEXT`;

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE, shares REAL NOT NULL, cost_basis REAL NOT NULL,
    is_cash_equivalent INTEGER NOT NULL DEFAULT 0,
    import_batch_id TEXT,
    ${SYNC_COLS})`);
  db.exec(`CREATE TABLE watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL UNIQUE,
    ${SYNC_COLS})`);
  for (const sql of syncTriggerSql()) {
    if (/ON (holdings|watchlist)[\s(]/.test(sql)) db.exec(sql);
  }
  return db;
}

const holdingsSpec = getSyncSpec("holdings")!;
const watchSpec = getSyncSpec("watchlist")!;

function syncAtoB(
  a: InstanceType<typeof Database>,
  host: InstanceType<typeof Database>,
  b: InstanceType<typeof Database>,
  spec: NonNullable<ReturnType<typeof getSyncSpec>>,
  stamp: () => string,
  since?: string
): string | null {
  const pending = collectPending(a, spec, "dev-a");
  if (pending.length > 0) {
    markPushed(a, spec, applyPush(host, spec, pending, stamp()).stamped);
  }
  const { rows, cursor } = serializePullRows(host, spec, "host", since);
  applyPull(b, spec, rows);
  return cursor;
}

test("watchlist + holdings are allowlisted with ticker natural key", () => {
  assert.deepEqual(watchSpec.naturalKey, ["ticker"]);
  assert.deepEqual(holdingsSpec.naturalKey, ["ticker"]);
  for (const col of ["ticker", "shares", "cost_basis", "is_cash_equivalent", "import_batch_id", "deleted_at"]) {
    assert.ok(holdingsSpec.columns.includes(col), `holdings syncs ${col}`);
  }
});

test("positions import tombstones a sold position and it disappears on the other device", () => {
  const a = freshDb();
  const host = freshDb();
  const b = freshDb();
  const stamp = createStamper();

  importHoldingsCore(a, [
    { ticker: "AAPL", shares: 10, cost_basis: 1500 },
    { ticker: "VTI", shares: 5, cost_basis: 1000 },
  ], true);
  const cursor = syncAtoB(a, host, b, holdingsSpec, stamp);
  assert.equal(
    (b.prepare("SELECT COUNT(*) AS n FROM holdings WHERE deleted_at IS NULL").get() as { n: number }).n,
    2
  );

  // Next statement: AAPL sold, VTI shares changed, MSFT bought.
  const result = importHoldingsCore(a, [
    { ticker: "VTI", shares: 8, cost_basis: 1600 },
    { ticker: "MSFT", shares: 2, cost_basis: 800 },
  ], true);
  assert.equal(result.tombstoned, 1, "AAPL tombstoned");
  syncAtoB(a, host, b, holdingsSpec, stamp, cursor ?? undefined);

  const live = b
    .prepare("SELECT ticker, shares FROM holdings WHERE deleted_at IS NULL ORDER BY ticker")
    .all() as Array<{ ticker: string; shares: number }>;
  assert.deepEqual(live, [
    { ticker: "MSFT", shares: 2 },
    { ticker: "VTI", shares: 8 },
  ], "sold position gone, changed + new positions live on B");
  const aapl = b.prepare("SELECT deleted_at FROM holdings WHERE ticker = 'AAPL'").get() as {
    deleted_at: string | null;
  };
  assert.ok(aapl.deleted_at, "AAPL is a tombstone on B, not a vanished row");
});

test("every row one import touches — upserts AND tombstones — shares its import_batch_id", () => {
  const db = freshDb();
  importHoldingsCore(db, [{ ticker: "AAPL", shares: 10, cost_basis: 1500 }], true);
  const { batchId } = importHoldingsCore(db, [{ ticker: "VTI", shares: 5, cost_basis: 1000 }], true);

  const rows = db.prepare("SELECT ticker, import_batch_id, deleted_at FROM holdings").all() as Array<{
    ticker: string;
    import_batch_id: string;
    deleted_at: string | null;
  }>;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.import_batch_id, batchId, `${row.ticker} stamped with the second import's batch`);
  }
  assert.ok(rows.find((r) => r.ticker === "AAPL")!.deleted_at, "tombstone stamped too");
});

test("history-mode import upserts only — nothing tombstoned", () => {
  const db = freshDb();
  importHoldingsCore(db, [{ ticker: "AAPL", shares: 10, cost_basis: 1500 }], true);
  const result = importHoldingsCore(db, [{ ticker: "VTI", shares: 5, cost_basis: 1000 }], false);
  assert.equal(result.tombstoned, 0);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM holdings WHERE deleted_at IS NULL").get() as { n: number }).n,
    2,
    "AAPL survives a partial history import"
  );
});

test("re-buying a sold ticker revives the same row (natural key, no duplicate identity)", () => {
  const db = freshDb();
  importHoldingsCore(db, [{ ticker: "AAPL", shares: 10, cost_basis: 1500 }], true);
  const id = (db.prepare("SELECT id FROM holdings WHERE ticker = 'AAPL'").get() as { id: number }).id;
  importHoldingsCore(db, [{ ticker: "VTI", shares: 5, cost_basis: 1000 }], true); // AAPL sold
  importHoldingsCore(db, [
    { ticker: "VTI", shares: 5, cost_basis: 1000 },
    { ticker: "AAPL", shares: 3, cost_basis: 600 },
  ], true); // re-bought

  const row = db.prepare("SELECT id, shares, deleted_at FROM holdings WHERE ticker = 'AAPL'").get() as {
    id: number;
    shares: number;
    deleted_at: string | null;
  };
  assert.equal(row.id, id, "same row identity");
  assert.equal(row.deleted_at, null);
  assert.equal(row.shares, 3);
});

// DOCUMENTS the accepted §4.4 interleave limitation — this test pins the
// current per-row last-write-wins behavior so a future change is noticed,
// not an assertion that the behavior is "solved".
test("KNOWN LIMITATION: two devices importing different statements interleave per-row", () => {
  const a = freshDb();
  const b = freshDb();
  const host = freshDb();
  const stamp = createStamper();

  // Shared starting state on both devices.
  importHoldingsCore(a, [{ ticker: "AAPL", shares: 10, cost_basis: 1500 }], true);
  syncAtoB(a, host, b, holdingsSpec, stamp);

  // A imports a NEWER statement (AAPL sold, VTI bought); B independently
  // imports a STALE one (AAPL still there) before syncing. B pushes last.
  importHoldingsCore(a, [{ ticker: "VTI", shares: 5, cost_basis: 1000 }], true);
  markPushed(a, holdingsSpec, applyPush(host, holdingsSpec, collectPending(a, holdingsSpec, "dev-a"), stamp()).stamped);
  importHoldingsCore(b, [{ ticker: "AAPL", shares: 10, cost_basis: 1500 }], true);
  markPushed(b, holdingsSpec, applyPush(host, holdingsSpec, collectPending(b, holdingsSpec, "dev-b"), stamp()).stamped);

  const live = host
    .prepare("SELECT ticker FROM holdings WHERE deleted_at IS NULL ORDER BY ticker")
    .all() as Array<{ ticker: string }>;
  // Per-row last-write-wins: B's stale import resurrects AAPL (its write is
  // newer at the host), and B can't tombstone VTI at all — B never pulled
  // that row, so its tombstone-the-rest pass has nothing local to tombstone.
  // The merged set is a union that matches NEITHER single statement.
  // Correct per the sync system's own rules; accepted because two devices
  // rarely both run brokerage imports between syncs.
  assert.deepEqual(live.map((r) => r.ticker), ["AAPL", "VTI"]);
});
