import { getDb } from "@/lib/db";
import { getCachedQuote } from "@/lib/stocks";
import { queueSyncPush } from "@/lib/sync/client";

// Net worth = manual account balances (debt subtracts) + holdings value.
// Holdings use the cached quote when warm, cost basis as the stated
// fallback — a valuation proxy, not a promise. A daily snapshot (cron +
// launch catch-up) builds the over-time chart.

export const ACCOUNT_KINDS = ["cash", "savings", "investment", "debt", "other"] as const;

export type Account = {
  id: number;
  name: string;
  kind: (typeof ACCOUNT_KINDS)[number];
  balance: number;
  updated_at: string;
};

export type NetWorthNow = {
  accountsTotal: number;
  holdingsValue: number;
  holdingsPriced: "market" | "cost-basis" | "none";
  total: number;
};

export function listAccounts(): Account[] {
  return getDb().prepare("SELECT * FROM accounts ORDER BY kind, name").all() as Account[];
}

export function computeNetWorth(): NetWorthNow {
  const db = getDb();
  const accountsTotal = (
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'debt' THEN -balance ELSE balance END), 0) AS t
         FROM accounts`
      )
      .get() as { t: number }
  ).t;

  const holdings = db
    .prepare("SELECT ticker, shares, cost_basis FROM holdings")
    .all() as { ticker: string; shares: number; cost_basis: number }[];
  let holdingsValue = 0;
  let anyMarket = false;
  for (const h of holdings) {
    const q = getCachedQuote(h.ticker);
    if (q) {
      holdingsValue += q.price * h.shares;
      anyMarket = true;
    } else {
      holdingsValue += h.cost_basis * h.shares;
    }
  }

  return {
    accountsTotal,
    holdingsValue,
    holdingsPriced:
      holdings.length === 0 ? "none" : anyMarket ? "market" : "cost-basis",
    total: accountsTotal + holdingsValue,
  };
}

export function takeSnapshot(): void {
  const now = computeNetWorth();
  const date = new Date().toISOString().slice(0, 10);
  const db = getDb();
  const save = db.transaction(() => {
    db.prepare("DELETE FROM networth_snapshots WHERE date = ?").run(date);
    db.prepare(
      "INSERT INTO networth_snapshots (date, accounts_total, holdings_value, total) VALUES (?, ?, ?, ?)"
    ).run(date, now.accountsTotal, now.holdingsValue, now.total);
  });
  save();
}

export type Snapshot = {
  date: string;
  accounts_total: number;
  holdings_value: number;
  total: number;
};

export function snapshots(days = 180): Snapshot[] {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return getDb()
    .prepare(
      "SELECT date, accounts_total, holdings_value, total FROM networth_snapshots WHERE date >= ? ORDER BY date ASC"
    )
    .all(since) as Snapshot[];
}

// Weekly delta: current total vs the closest snapshot ≥7 days old.
export function weeklyDelta(): number | null {
  const rows = snapshots(30);
  if (rows.length === 0) return null;
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const base = [...rows].reverse().find((r) => r.date <= weekAgo);
  if (!base) return null;
  return computeNetWorth().total - base.total;
}

// Cron job: daily snapshot + launch catch-up. Skips when there's nothing
// to value (no accounts and no holdings) so an unused feature stays quiet.
export async function netWorthSnapshotJob(): Promise<void> {
  const db = getDb();
  const hasAccounts = db.prepare("SELECT 1 FROM accounts LIMIT 1").get();
  const hasHoldings = db.prepare("SELECT 1 FROM holdings LIMIT 1").get();
  if (!hasAccounts && !hasHoldings) {
    console.log("[networth] nothing to snapshot (no accounts or holdings)");
    return;
  }
  takeSnapshot();
  queueSyncPush(); // debounced; no-op unless SYNC_ROLE=client
  console.log("[networth] snapshot taken");
}
