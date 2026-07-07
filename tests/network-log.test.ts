import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  hostOf,
  insertNetworkLog,
  loggedFetchWith,
  pruneNetworkLog,
  MAX_ROWS,
  type NetworkLogEntry,
} from "../lib/network-log-core.ts";

// No real network anywhere in here: fetch is mocked, sqlite is in-memory.

const meta = { feature: "stocks-refresh", purpose: "fetch quote" };

function capture(): { entries: NetworkLogEntry[]; record: (e: NetworkLogEntry) => void } {
  const entries: NetworkLogEntry[] = [];
  return { entries, record: (e) => entries.push(e) };
}

test("logs metadata only: host without path/query/credentials", async () => {
  const { entries, record } = capture();
  const fetchImpl = async () => new Response("{}", { status: 200 });
  await loggedFetchWith(
    { fetchImpl, record },
    "https://finnhub.io/api/v1/quote?symbol=AAPL&token=SECRET",
    undefined,
    meta
  );
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    "feature",
    "host",
    "latencyMs",
    "outcome",
    "purpose",
    "statusCode",
  ]);
  assert.equal(entry.host, "finnhub.io"); // no path, no query, no token
  assert.equal(entry.feature, "stocks-refresh");
  assert.equal(entry.purpose, "fetch quote");
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.statusCode, 200);
  assert.ok(entry.latencyMs >= 0);
});

test("non-2xx responses log outcome=error with the status code", async () => {
  const { entries, record } = capture();
  const fetchImpl = async () => new Response("nope", { status: 429 });
  const res = await loggedFetchWith({ fetchImpl, record }, "https://slack.com/api/x", undefined, meta);
  assert.equal(res.status, 429); // response still returned to the caller
  assert.equal(entries[0].outcome, "error");
  assert.equal(entries[0].statusCode, 429);
});

test("a thrown fetch is logged (no status) and rethrown to the caller", async () => {
  const { entries, record } = capture();
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    () => loggedFetchWith({ fetchImpl, record }, "https://leetcode.com/graphql", undefined, meta),
    /ECONNREFUSED/
  );
  assert.equal(entries[0].outcome, "error");
  assert.equal(entries[0].statusCode, null);
});

test("a broken recorder never breaks the call it observed", async () => {
  const fetchImpl = async () => new Response("{}", { status: 200 });
  const record = () => {
    throw new Error("disk full");
  };
  const res = await loggedFetchWith({ fetchImpl, record }, "https://example.com", undefined, meta);
  assert.equal(res.status, 200);
});

test("hostOf survives garbage urls without leaking them", () => {
  assert.equal(hostOf("not a url"), "(unparseable url)");
});

// ---- retention, against a real (in-memory) sqlite ----

const SCHEMA = `CREATE TABLE network_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  feature TEXT NOT NULL, host TEXT NOT NULL, purpose TEXT NOT NULL,
  outcome TEXT NOT NULL, status_code INTEGER, latency_ms INTEGER NOT NULL
)`;

const entry: NetworkLogEntry = {
  feature: "f",
  host: "h",
  purpose: "p",
  outcome: "ok",
  statusCode: 200,
  latencyMs: 5,
};

test("prune drops rows older than the retention window, keeps the rest", () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  insertNetworkLog(db, entry);
  db.prepare("UPDATE network_log SET timestamp = '2026-01-01T00:00:00Z'").run(); // 6 months old
  insertNetworkLog(db, entry); // fresh
  pruneNetworkLog(db, new Date("2026-07-07T00:00:00Z"));
  const rows = db.prepare("SELECT timestamp FROM network_log").all() as { timestamp: string }[];
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].timestamp, "2026-01-01T00:00:00Z");
});

test("prune caps total rows at MAX_ROWS, keeping the newest", () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  const insert = db.prepare(
    "INSERT INTO network_log (feature, host, purpose, outcome, status_code, latency_ms) VALUES ('f','h','p','ok',200,1)"
  );
  const overshoot = 25;
  for (let i = 0; i < MAX_ROWS + overshoot; i++) insert.run();
  pruneNetworkLog(db);
  const { n, maxId } = db
    .prepare("SELECT COUNT(*) AS n, MAX(id) AS maxId FROM network_log")
    .get() as { n: number; maxId: number };
  assert.equal(n, MAX_ROWS);
  assert.equal(maxId, MAX_ROWS + overshoot); // newest rows survived
});
