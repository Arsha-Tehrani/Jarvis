import type Database from "better-sqlite3";

// Automated dividend detection — the testable core (db passed in, deps
// injected, no @/ imports; the trackers-migrate.ts / sync-core pattern).
// The cron glue that binds this to the real DB and the shared Yahoo client
// lives in lib/dividends-scan.ts. Full design + the empirically verified
// Yahoo field mapping: docs/dividend-automation.md.

export type DividendCalendar = { exDate: string | null; paymentDate: string | null };
export type LastPayment = { amount: number; date: string } | null;

export type DividendScanDeps = {
  // quoteSummary calendarEvents, already reduced to the two verified fields.
  fetchCalendar: (ticker: string) => Promise<DividendCalendar>;
  // Most recent actual per-share payment from chart dividend events — the
  // estimate used because summaryDetail.dividendRate is annualized (verified,
  // see docs/dividend-automation.md Step 0).
  fetchLastPaymentAmount: (ticker: string) => Promise<LastPayment>;
  log: (message: string) => void;
};

export type DividendScanResult = {
  inserted: string[]; // tickers that got a new pending row
  promoted: number; // pending rows flipped to confirmed
  failed: string[]; // tickers whose fetch failed (logged, skipped, never fatal)
};

// Yahoo dates arrive as JS Date objects (sometimes ISO strings after
// serialization) — reduce to the app's YYYY-MM-DD convention.
export function toIsoDate(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const iso = v instanceof Date ? v.toISOString() : String(v);
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

// The two verified calendarEvents fields (docs/dividend-automation.md Step
// 0: exDividendDate = ex-date, dividendDate = PAYMENT date — cross-checked
// against Apple IR, not assumed from the names).
export function calendarFromQuoteSummary(qs: {
  calendarEvents?: {
    exDividendDate?: Date | string | null;
    dividendDate?: Date | string | null;
  };
}): DividendCalendar {
  return {
    exDate: toIsoDate(qs.calendarEvents?.exDividendDate),
    paymentDate: toIsoDate(qs.calendarEvents?.dividendDate),
  };
}

// Most recent per-share payment from chart dividend events (keyed by
// ex-date). Used as the ESTIMATED upcoming amount — summaryDetail's
// dividendRate is annualized, verified unusable per-payment.
export function lastPaymentFromChart(chart: {
  events?: { dividends?: Array<{ amount?: number | null; date?: Date | string | null }> };
}): LastPayment {
  const events = (chart.events?.dividends ?? [])
    .map((d) => ({ amount: d.amount, date: toIsoDate(d.date) }))
    .filter((d): d is { amount: number; date: string } =>
      typeof d.amount === "number" && Number.isFinite(d.amount) && d.amount > 0 && d.date != null
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  return events.length > 0 ? events[events.length - 1] : null;
}

// Promotion: entitlement becomes real cash on the payment date, not before.
// A pending row with no payment date recorded can never auto-promote — it
// waits for a human correction rather than guessing.
export function isPromotionDue(paymentDate: string | null, today: string): boolean {
  return paymentDate != null && paymentDate <= today;
}

export async function runDividendScan(
  db: Database.Database,
  deps: DividendScanDeps,
  today: string
): Promise<DividendScanResult> {
  const result: DividendScanResult = { inserted: [], promoted: 0, failed: [] };

  const tickers = (
    db
      .prepare("SELECT DISTINCT UPPER(ticker) AS ticker FROM holdings WHERE deleted_at IS NULL")
      .all() as {
      ticker: string;
    }[]
  ).map((r) => r.ticker);

  for (const ticker of tickers) {
    // One ticker's failure never blocks the rest (LeetCode-puller posture).
    try {
      const cal = await deps.fetchCalendar(ticker);
      if (cal.exDate !== today) continue;

      // Existing row of EITHER source wins (the table's UNIQUE(ticker,
      // ex_date)): a hand-logged dividend never gets an auto twin, and a
      // hand-corrected auto row is never clobbered by the next tick.
      const exists = db
        .prepare("SELECT 1 FROM dividend_log WHERE ticker = ? AND ex_date = ?")
        .get(ticker, cal.exDate);
      if (exists) continue;

      const last = await deps.fetchLastPaymentAmount(ticker);
      if (!last) {
        deps.log(`${ticker}: ex-dividend today but no historical payment amount — skipped`);
        continue;
      }

      // Last-imported-statement share count, NOT a true point-in-time
      // balance as of market open on the ex-date — Jarvis has no live
      // brokerage feed, only periodic statement imports. Known limitation,
      // stated in docs/dividend-automation.md.
      const holding = db
        .prepare(
          "SELECT shares FROM holdings WHERE UPPER(ticker) = ? AND deleted_at IS NULL LIMIT 1"
        )
        .get(ticker) as { shares: number } | undefined;

      db.prepare(
        `INSERT INTO dividend_log
           (ticker, ex_date, amount_per_share, shares_at_date, note, status, payment_date, source)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, 'yahoo_auto')
         ON CONFLICT(ticker, ex_date) DO NOTHING`
      ).run(
        ticker,
        cal.exDate,
        last.amount,
        holding?.shares ?? null,
        `auto-detected; amount estimated from last payment ($${last.amount}/sh on ${last.date})`,
        cal.paymentDate
      );
      result.inserted.push(ticker);
      deps.log(`${ticker}: pending dividend recorded (ex ${cal.exDate}, pays ${cal.paymentDate ?? "?"})`);
    } catch (err) {
      result.failed.push(ticker);
      deps.log(`${ticker}: dividend scan failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Second pass: promote pending rows whose payment date has arrived. Done
  // row-by-row through isPromotionDue so the decision has exactly one
  // implementation (the one under test), not a parallel SQL copy.
  const pending = db
    .prepare("SELECT id, payment_date FROM dividend_log WHERE status = 'pending'")
    .all() as { id: number; payment_date: string | null }[];
  const promote = db.prepare("UPDATE dividend_log SET status = 'confirmed' WHERE id = ?");
  for (const row of pending) {
    if (isPromotionDue(row.payment_date, today)) {
      promote.run(row.id);
      result.promoted++;
    }
  }

  return result;
}
