import { getDb } from "@/lib/db";
import {
  buildFinanceFilter,
  type FinanceQueryArgs,
} from "@/lib/finance/query-builder";

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
