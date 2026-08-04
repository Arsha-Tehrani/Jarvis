import { getDb } from "@/lib/db";
import { dividendPayout, summarizeDividends, type DividendStatus } from "@/lib/dividends-math";

// Dividend income tracking. Manual entry is the always-working base path
// (same philosophy as LeetCode manual entry); the daily dividend-scan cron
// (lib/dividends-scan.ts, docs/dividend-automation.md) adds `pending` rows
// automatically on a holding's ex-date and promotes them to `confirmed` on
// the payment date. Only `confirmed` rows count toward the running total —
// the pure math lives in dividends-math.ts (unit-tested).

export { dividendPayout } from "@/lib/dividends-math";

export type DividendEvent = {
  id: number;
  ticker: string;
  ex_date: string;
  amount_per_share: number;
  shares_at_date: number | null;
  note: string | null;
  status: DividendStatus;
  payment_date: string | null;
  source: "manual" | "yahoo_auto";
  payout: number;
  approximate: boolean; // true when payout used the current share count
};

export type DividendSummary = {
  total: number; // confirmed only
  pendingTotal: number; // entitlements not yet paid — never in `total`
  byHolding: Array<{ ticker: string; total: number; events: number; approximate: boolean }>;
  events: DividendEvent[];
};

export function dividendSummary(): DividendSummary {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, ticker, ex_date, amount_per_share, shares_at_date, note, status, payment_date, source FROM dividend_log ORDER BY ex_date DESC, ticker"
    )
    .all() as Array<{
    id: number;
    ticker: string;
    ex_date: string;
    amount_per_share: number;
    shares_at_date: number | null;
    note: string | null;
    status: DividendStatus;
    payment_date: string | null;
    source: "manual" | "yahoo_auto";
  }>;
  const currentShares = new Map(
    (db.prepare("SELECT ticker, shares FROM holdings WHERE deleted_at IS NULL").all() as {
      ticker: string;
      shares: number;
    }[]).map((r) => [r.ticker.toUpperCase(), r.shares])
  );

  const events: DividendEvent[] = rows.map((r) => {
    const { payout, approximate } = dividendPayout(
      r.amount_per_share,
      r.shares_at_date,
      currentShares.get(r.ticker.toUpperCase()) ?? 0
    );
    return { ...r, payout, approximate };
  });

  return { ...summarizeDividends(events), events };
}

export function logDividend(
  ticker: string,
  exDate: string,
  amountPerShare: number,
  sharesAtDate: number | null,
  note: string | null
): void {
  getDb()
    .prepare(
      `INSERT INTO dividend_log (ticker, ex_date, amount_per_share, shares_at_date, note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ticker, ex_date) DO UPDATE SET
         amount_per_share = excluded.amount_per_share,
         shares_at_date = excluded.shares_at_date,
         note = excluded.note`
    )
    .run(ticker.toUpperCase(), exDate, amountPerShare, sharesAtDate, note);
}

export function deleteDividend(id: number): boolean {
  return getDb().prepare("DELETE FROM dividend_log WHERE id = ?").run(id).changes > 0;
}
