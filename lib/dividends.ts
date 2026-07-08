import { getDb } from "@/lib/db";
import { dividendPayout, round2 } from "@/lib/dividends-math";

// Dividend income tracking. The configured free-tier quote providers don't
// expose dividends (Finnhub's dividend endpoint is premium; Alpha Vantage
// dropped free dividend-adjusted data), so — same philosophy as the LeetCode
// manual entry — dividends are logged by hand and this module does the math.
// The payout math lives in the pure dividends-math.ts (unit-tested).

export { dividendPayout } from "@/lib/dividends-math";

export type DividendEvent = {
  id: number;
  ticker: string;
  ex_date: string;
  amount_per_share: number;
  shares_at_date: number | null;
  note: string | null;
  payout: number;
  approximate: boolean; // true when payout used the current share count
};

export type DividendSummary = {
  total: number;
  byHolding: Array<{ ticker: string; total: number; events: number; approximate: boolean }>;
  events: DividendEvent[];
};

export function dividendSummary(): DividendSummary {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, ticker, ex_date, amount_per_share, shares_at_date, note FROM dividend_log ORDER BY ex_date DESC, ticker"
    )
    .all() as Array<{
    id: number;
    ticker: string;
    ex_date: string;
    amount_per_share: number;
    shares_at_date: number | null;
    note: string | null;
  }>;
  const currentShares = new Map(
    (db.prepare("SELECT ticker, shares FROM holdings").all() as {
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

  const byTicker = new Map<string, { total: number; events: number; approximate: boolean }>();
  for (const e of events) {
    const prev = byTicker.get(e.ticker) ?? { total: 0, events: 0, approximate: false };
    byTicker.set(e.ticker, {
      total: round2(prev.total + e.payout),
      events: prev.events + 1,
      approximate: prev.approximate || e.approximate,
    });
  }

  return {
    total: round2(events.reduce((s, e) => s + e.payout, 0)),
    byHolding: [...byTicker.entries()]
      .map(([ticker, v]) => ({ ticker, ...v }))
      .sort((a, b) => b.total - a.total),
    events,
  };
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
