import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import {
  calendarFromQuoteSummary,
  isPromotionDue,
  lastPaymentFromChart,
  runDividendScan,
  toIsoDate,
  type DividendScanDeps,
} from "../lib/dividends-auto.ts";
import { summarizeDividends } from "../lib/dividends-math.ts";

// No live Yahoo anywhere in here (unofficial-API rule): the scan runs
// against an in-memory DB with stubbed deps, and the field extraction runs
// against fixture objects shaped like real responses (the shapes recorded
// in docs/dividend-automation.md Step 0).

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      shares REAL NOT NULL,
      cost_basis REAL,
      deleted_at TEXT
    );
    CREATE TABLE dividend_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      ex_date TEXT NOT NULL,
      amount_per_share REAL NOT NULL,
      shares_at_date REAL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed',
      payment_date TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      UNIQUE(ticker, ex_date)
    );
  `);
  return db;
}

const quiet = () => {};

function deps(overrides: Partial<DividendScanDeps>): DividendScanDeps {
  return {
    fetchCalendar: async () => ({ exDate: null, paymentDate: null }),
    fetchLastPaymentAmount: async () => null,
    log: quiet,
    ...overrides,
  };
}

// --- field extraction -------------------------------------------------

test("toIsoDate: Date objects, ISO strings, junk, null", () => {
  assert.equal(toIsoDate(new Date("2026-05-11T00:00:00.000Z")), "2026-05-11");
  assert.equal(toIsoDate("2026-05-14T00:00:00.000Z"), "2026-05-14");
  assert.equal(toIsoDate("not a date"), null);
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate(undefined), null);
});

test("calendarFromQuoteSummary maps the two VERIFIED fields (ex = exDividendDate, pay = dividendDate)", () => {
  // Shape recorded from the real AAPL response on 2026-07-10; the mapping
  // was cross-checked against Apple IR (see docs/dividend-automation.md).
  const cal = calendarFromQuoteSummary({
    calendarEvents: {
      exDividendDate: new Date("2026-05-11T00:00:00.000Z"),
      dividendDate: new Date("2026-05-14T00:00:00.000Z"),
    },
  });
  assert.deepEqual(cal, { exDate: "2026-05-11", paymentDate: "2026-05-14" });
});

test("calendarFromQuoteSummary: missing module/fields → nulls, no throw", () => {
  assert.deepEqual(calendarFromQuoteSummary({}), { exDate: null, paymentDate: null });
  assert.deepEqual(calendarFromQuoteSummary({ calendarEvents: {} }), {
    exDate: null,
    paymentDate: null,
  });
});

test("lastPaymentFromChart picks the most recent real payment", () => {
  const last = lastPaymentFromChart({
    events: {
      dividends: [
        { amount: 0.26, date: new Date("2026-02-09T00:00:00.000Z") },
        { amount: 0.27, date: new Date("2026-05-11T00:00:00.000Z") },
        { amount: 0.26, date: new Date("2025-11-10T00:00:00.000Z") },
      ],
    },
  });
  assert.deepEqual(last, { amount: 0.27, date: "2026-05-11" });
});

test("lastPaymentFromChart: no events, junk amounts → null / filtered", () => {
  assert.equal(lastPaymentFromChart({}), null);
  assert.equal(lastPaymentFromChart({ events: { dividends: [] } }), null);
  assert.equal(
    lastPaymentFromChart({ events: { dividends: [{ amount: 0, date: "2026-01-01" }] } }),
    null
  );
});

// --- promotion decision ------------------------------------------------

test("isPromotionDue: payment date today or past → due; future or unknown → not", () => {
  assert.equal(isPromotionDue("2026-07-10", "2026-07-10"), true);
  assert.equal(isPromotionDue("2026-07-01", "2026-07-10"), true);
  assert.equal(isPromotionDue("2026-07-14", "2026-07-10"), false);
  assert.equal(isPromotionDue(null, "2026-07-10"), false);
});

// --- the scan ----------------------------------------------------------

test("ex-date today → pending row with locked shares, payment date, yahoo_auto source", async () => {
  const db = freshDb();
  db.prepare("INSERT INTO holdings (ticker, shares) VALUES ('AAPL', 12)").run();
  const result = await runDividendScan(
    db,
    deps({
      fetchCalendar: async () => ({ exDate: "2026-07-10", paymentDate: "2026-07-14" }),
      fetchLastPaymentAmount: async () => ({ amount: 0.27, date: "2026-05-11" }),
    }),
    "2026-07-10"
  );
  assert.deepEqual(result.inserted, ["AAPL"]);
  const row = db.prepare("SELECT * FROM dividend_log").get() as Record<string, unknown>;
  assert.equal(row.ticker, "AAPL");
  assert.equal(row.ex_date, "2026-07-10");
  assert.equal(row.amount_per_share, 0.27);
  assert.equal(row.shares_at_date, 12);
  assert.equal(row.status, "pending");
  assert.equal(row.payment_date, "2026-07-14");
  assert.equal(row.source, "yahoo_auto");
  assert.match(String(row.note), /estimated from last payment/);
});

test("ex-date NOT today → nothing inserted", async () => {
  const db = freshDb();
  db.prepare("INSERT INTO holdings (ticker, shares) VALUES ('AAPL', 12)").run();
  const result = await runDividendScan(
    db,
    deps({
      fetchCalendar: async () => ({ exDate: "2026-08-10", paymentDate: "2026-08-14" }),
      fetchLastPaymentAmount: async () => ({ amount: 0.27, date: "2026-05-11" }),
    }),
    "2026-07-10"
  );
  assert.deepEqual(result.inserted, []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM dividend_log").get() as { n: number }).n, 0);
});

test("existing (ticker, ex_date) row of EITHER source wins — no duplicate, no clobber", async () => {
  const db = freshDb();
  db.prepare("INSERT INTO holdings (ticker, shares) VALUES ('AAPL', 12)").run();
  // The user hand-logged this dividend already, with their own corrected amount.
  db.prepare(
    "INSERT INTO dividend_log (ticker, ex_date, amount_per_share, status, source) VALUES ('AAPL', '2026-07-10', 0.30, 'confirmed', 'manual')"
  ).run();
  const result = await runDividendScan(
    db,
    deps({
      fetchCalendar: async () => ({ exDate: "2026-07-10", paymentDate: "2026-07-14" }),
      fetchLastPaymentAmount: async () => ({ amount: 0.27, date: "2026-05-11" }),
    }),
    "2026-07-10"
  );
  assert.deepEqual(result.inserted, []);
  const rows = db.prepare("SELECT * FROM dividend_log").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_per_share, 0.3); // the manual row untouched
  assert.equal(rows[0].source, "manual");
});

test("repeated same-day tick is idempotent (the auto row itself blocks a twin)", async () => {
  const db = freshDb();
  db.prepare("INSERT INTO holdings (ticker, shares) VALUES ('AAPL', 12)").run();
  const d = deps({
    fetchCalendar: async () => ({ exDate: "2026-07-10", paymentDate: "2026-07-14" }),
    fetchLastPaymentAmount: async () => ({ amount: 0.27, date: "2026-05-11" }),
  });
  await runDividendScan(db, d, "2026-07-10");
  const second = await runDividendScan(db, d, "2026-07-10");
  assert.deepEqual(second.inserted, []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM dividend_log").get() as { n: number }).n, 1);
});

test("one ticker's fetch failure is logged and skipped — the rest of the run continues", async () => {
  const db = freshDb();
  db.prepare("INSERT INTO holdings (ticker, shares) VALUES ('BROKEN', 5)").run();
  db.prepare("INSERT INTO holdings (ticker, shares) VALUES ('GOOD', 8)").run();
  const logged: string[] = [];
  const result = await runDividendScan(
    db,
    deps({
      fetchCalendar: async (ticker) => {
        if (ticker === "BROKEN") throw new Error("connect ECONNREFUSED (unofficial API down)");
        return { exDate: "2026-07-10", paymentDate: "2026-07-15" };
      },
      fetchLastPaymentAmount: async () => ({ amount: 1.1, date: "2026-04-01" }),
      log: (m) => logged.push(m),
    }),
    "2026-07-10"
  );
  assert.deepEqual(result.failed, ["BROKEN"]);
  assert.deepEqual(result.inserted, ["GOOD"]);
  assert.ok(logged.some((m) => m.includes("BROKEN") && m.includes("failed")));
});

test("promotion pass: due pending rows flip to confirmed; future and no-date rows wait", async () => {
  const db = freshDb();
  db.prepare(
    "INSERT INTO dividend_log (ticker, ex_date, amount_per_share, status, payment_date, source) VALUES ('A', '2026-07-01', 1, 'pending', '2026-07-10', 'yahoo_auto')"
  ).run();
  db.prepare(
    "INSERT INTO dividend_log (ticker, ex_date, amount_per_share, status, payment_date, source) VALUES ('B', '2026-07-01', 1, 'pending', '2026-08-01', 'yahoo_auto')"
  ).run();
  db.prepare(
    "INSERT INTO dividend_log (ticker, ex_date, amount_per_share, status, source) VALUES ('C', '2026-07-01', 1, 'pending', 'yahoo_auto')"
  ).run();
  const result = await runDividendScan(db, deps({}), "2026-07-10");
  assert.equal(result.promoted, 1);
  const byTicker = Object.fromEntries(
    (db.prepare("SELECT ticker, status FROM dividend_log").all() as {
      ticker: string;
      status: string;
    }[]).map((r) => [r.ticker, r.status])
  );
  assert.deepEqual(byTicker, { A: "confirmed", B: "pending", C: "pending" });
});

// --- the number a user could act on -------------------------------------

test("summarizeDividends: pending contributes ZERO to total and byHolding until confirmed", () => {
  const summary = summarizeDividends([
    { ticker: "AAPL", payout: 50, approximate: false, status: "confirmed" },
    { ticker: "AAPL", payout: 48, approximate: false, status: "confirmed" },
    { ticker: "GOOGL", payout: 30, approximate: true, status: "pending" },
    { ticker: "META", payout: 20, approximate: false, status: "pending" },
  ]);
  assert.equal(summary.total, 98); // confirmed only
  assert.equal(summary.pendingTotal, 50);
  assert.deepEqual(summary.byHolding, [
    { ticker: "AAPL", total: 98, events: 2, approximate: false },
    // GOOGL and META absent — pending rows don't appear in the breakdown
  ]);
});

test("summarizeDividends: all-pending set shows a zero total, not a hopeful one", () => {
  const summary = summarizeDividends([
    { ticker: "GOOGL", payout: 30, approximate: true, status: "pending" },
  ]);
  assert.equal(summary.total, 0);
  assert.equal(summary.pendingTotal, 30);
  assert.deepEqual(summary.byHolding, []);
});
