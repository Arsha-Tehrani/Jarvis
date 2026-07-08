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

export type BalanceSuggestion = {
  label: string; // e.g. "Checking"
  kind: "cash" | "debt";
  balance: number;
  month: string | null;
  accountId: number | null; // matching account, if one exists
  currentBalance: number | null; // its current balance, to show the delta
};

// Net worth account balances are entered by hand, so without a manual entry
// they read $0 even after importing a statement that plainly states the
// balance. This surfaces the captured ending balance (per label, most recent
// statement) as a SUGGESTION to create/update the matching account — the write
// itself stays behind the existing confirm-gated accounts endpoint. Only
// suggests when the number is new or differs from the current balance.
export function balanceSuggestions(): BalanceSuggestion[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT balance_label AS label, balance_kind AS kind, ending_balance AS balance, month
       FROM statements s
       WHERE ending_balance IS NOT NULL
         AND imported_at = (
           SELECT MAX(imported_at) FROM statements s2 WHERE s2.balance_label = s.balance_label
         )`
    )
    .all() as Array<{ label: string; kind: "cash" | "debt"; balance: number; month: string | null }>;

  const suggestions: BalanceSuggestion[] = [];
  for (const r of rows) {
    const account = db
      .prepare("SELECT id, balance FROM accounts WHERE name = ?")
      .get(r.label) as { id: number; balance: number } | undefined;
    // Skip when the account already matches the statement to the cent.
    if (account && Math.abs(account.balance - r.balance) < 0.005) continue;
    suggestions.push({
      label: r.label,
      kind: r.kind,
      balance: r.balance,
      month: r.month,
      accountId: account?.id ?? null,
      currentBalance: account?.balance ?? null,
    });
  }
  return suggestions;
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
