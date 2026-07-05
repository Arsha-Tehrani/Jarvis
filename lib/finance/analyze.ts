import { getDb } from "@/lib/db";

// Read-side of the finance module: everything the Finance tab renders.
// Spend is negative amounts, sign-flipped for display. Transfers and
// investments are excluded from "spend" so moving money isn't spending.

const NON_SPEND = ["Transfer", "Investment"];
const DISCRETIONARY = ["Dining", "Entertainment", "Shopping", "Subscriptions", "Travel"];

export type CategorySpend = { category: string; thisMonth: number; lastMonth: number };

export type RecurringCharge = {
  merchant: string;
  amount: number;
  occurrences: number;
  lastDate: string;
  monthlyCost: number;
};

export type MonthSummary = {
  month: string;
  income: number;
  spend: number;
  invested: number;
  net: number;
};

export type CutbackSuggestion = {
  goalKind: string;
  target: number;
  actual: number;
  message: string;
  suggestions: Array<{ category: string; spend: number; cutNeeded: number }>;
};

export type Goal = { id: number; kind: string; target: number; period: string };

function monthKey(offset = 0): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return d.toISOString().slice(0, 7);
}

export function spendByCategory(): CategorySpend[] {
  const db = getDb();
  const thisMonth = monthKey(0);
  const lastMonth = monthKey(-1);
  const rows = db
    .prepare(
      `SELECT category, substr(date, 1, 7) AS month, SUM(-amount) AS spend
       FROM transactions
       WHERE amount < 0
         AND category NOT IN (${NON_SPEND.map(() => "?").join(",")})
         AND substr(date, 1, 7) IN (?, ?)
       GROUP BY category, month`
    )
    .all(...NON_SPEND, thisMonth, lastMonth) as {
    category: string;
    month: string;
    spend: number;
  }[];

  const byCategory = new Map<string, CategorySpend>();
  for (const row of rows) {
    const entry =
      byCategory.get(row.category) ??
      ({ category: row.category, thisMonth: 0, lastMonth: 0 } as CategorySpend);
    if (row.month === thisMonth) entry.thisMonth = row.spend;
    else entry.lastMonth = row.spend;
    byCategory.set(row.category, entry);
  }
  return [...byCategory.values()].sort(
    (a, b) => b.thisMonth + b.lastMonth - (a.thisMonth + a.lastMonth)
  );
}

export function recurringCharges(): RecurringCharge[] {
  const rows = getDb()
    .prepare(
      `SELECT merchant, AVG(-amount) AS amount, COUNT(*) AS occurrences, MAX(date) AS lastDate
       FROM transactions WHERE is_recurring = 1
       GROUP BY merchant ORDER BY amount DESC`
    )
    .all() as { merchant: string; amount: number; occurrences: number; lastDate: string }[];
  return rows.map((r) => ({ ...r, monthlyCost: r.amount }));
}

export function monthSummaries(): MonthSummary[] {
  const db = getDb();
  const months = [monthKey(-1), monthKey(0)];
  return months.map((month) => {
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN amount > 0 AND category NOT IN ('Transfer') THEN amount END), 0) AS income,
           COALESCE(SUM(CASE WHEN amount < 0 AND category NOT IN (${NON_SPEND.map(() => "?").join(",")}) THEN -amount END), 0) AS spend,
           COALESCE(SUM(CASE WHEN amount < 0 AND category = 'Investment' THEN -amount END), 0) AS invested
         FROM transactions WHERE substr(date, 1, 7) = ?`
      )
      .get(...NON_SPEND, month) as { income: number; spend: number; invested: number };
    return {
      month,
      income: row.income,
      spend: row.spend,
      invested: row.invested,
      net: row.income - row.spend - row.invested,
    };
  });
}

export function listGoals(): Goal[] {
  return getDb().prepare("SELECT id, kind, target, period FROM goals ORDER BY kind").all() as Goal[];
}

// Cut-back tips measured against real targets (goals), not vibes.
export function cutbackSuggestions(): CutbackSuggestion[] {
  const goals = listGoals();
  const savingsGoal = goals.find((g) => g.kind === "savings_rate");
  if (!savingsGoal) return [];

  const [, current] = monthSummaries();
  if (current.income <= 0) {
    return [
      {
        goalKind: "savings_rate",
        target: savingsGoal.target,
        actual: 0,
        message: "No income recorded this month yet — import a statement to measure your savings rate.",
        suggestions: [],
      },
    ];
  }

  const saved = current.income - current.spend;
  const actualRate = (saved / current.income) * 100;
  if (actualRate >= savingsGoal.target) {
    return [
      {
        goalKind: "savings_rate",
        target: savingsGoal.target,
        actual: actualRate,
        message: `On track: saving ${actualRate.toFixed(0)}% this month (target ${savingsGoal.target}%).`,
        suggestions: [],
      },
    ];
  }

  const shortfall = (savingsGoal.target / 100) * current.income - saved;
  const spend = spendByCategory().filter((c) => DISCRETIONARY.includes(c.category));
  let remaining = shortfall;
  const suggestions = spend
    .filter((c) => c.thisMonth > 0)
    .sort((a, b) => b.thisMonth - a.thisMonth)
    .slice(0, 3)
    .map((c) => {
      const cut = Math.min(c.thisMonth, remaining);
      remaining -= cut;
      return { category: c.category, spend: c.thisMonth, cutNeeded: cut };
    })
    .filter((s) => s.cutNeeded > 0);

  return [
    {
      goalKind: "savings_rate",
      target: savingsGoal.target,
      actual: actualRate,
      message: `Saving ${actualRate.toFixed(0)}% vs target ${savingsGoal.target}% — cut ~$${shortfall.toFixed(0)} to hit it.`,
      suggestions,
    },
  ];
}
