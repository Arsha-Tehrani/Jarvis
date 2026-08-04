import { getDb } from "@/lib/db";
import {
  buildFinanceFilter,
  type FinanceQueryArgs,
} from "@/lib/finance/query-builder";
import { comparisonPeriod, latestPeriod } from "@/lib/finance/period";

// The distinct YYYY-MM months that actually have transactions, oldest→newest.
// The single source of truth for "which months exist" — month navigation and
// the derived current/comparison periods all read from this.
export function periodsWithData(): string[] {
  return (
    getDb()
      .prepare("SELECT DISTINCT substr(date, 1, 7) AS m FROM transactions ORDER BY m")
      .all() as { m: string }[]
  ).map((r) => r.m);
}

// The baseline "current" period: the month of the most recent imported
// transaction, not the system clock. Null when there are no transactions.
export function getLatestPeriod(): string | null {
  return latestPeriod(periodsWithData());
}

// The month to compare against (immediately-preceding month, only if it has
// data). Null when there isn't enough history.
export function getComparisonPeriod(): string | null {
  return comparisonPeriod(periodsWithData());
}

export type FinanceQueryResult = {
  total: number;
  count: number;
  byCategory: Array<{ category: string; amount: number }>;
};

export function runFinanceQuery(args: FinanceQueryArgs): FinanceQueryResult {
  const db = getDb();
  const { where, params, sumExpr } = buildFinanceFilter(args);

  const totals = db
    .prepare(
      `SELECT COALESCE(${sumExpr}, 0) AS total, COUNT(*) AS count
       FROM transactions WHERE ${where}`
    )
    .get(...params) as { total: number; count: number };

  const byCategory = db
    .prepare(
      `SELECT category, COALESCE(${sumExpr}, 0) AS amount
       FROM transactions WHERE ${where}
       GROUP BY category ORDER BY ABS(amount) DESC LIMIT 8`
    )
    .all(...params) as Array<{ category: string; amount: number }>;

  return { total: totals.total, count: totals.count, byCategory };
}

export function formatFinanceAnswer(
  args: FinanceQueryArgs,
  result: FinanceQueryResult
): string {
  const usd = (v: number) =>
    `$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const scope = [
    args.category,
    args.merchant_contains && `matching "${args.merchant_contains}"`,
    args.month,
    args.start_date && `from ${args.start_date}`,
    args.end_date && `to ${args.end_date}`,
  ]
    .filter(Boolean)
    .join(", ");

  const headline = `${args.metric === "spend" ? "Spend" : args.metric === "income" ? "Income" : "Net"}${scope ? ` (${scope})` : ""}: ${result.total < 0 ? "-" : ""}${usd(result.total)} across ${result.count} transaction${result.count === 1 ? "" : "s"}.`;

  if (result.byCategory.length <= 1) return headline;
  const breakdown = result.byCategory
    .map((c) => `${c.category} ${c.amount < 0 ? "-" : ""}${usd(c.amount)}`)
    .join(", ");
  return `${headline}\nBreakdown: ${breakdown}.`;
}
