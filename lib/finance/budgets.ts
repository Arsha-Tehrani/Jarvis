import { getDb } from "@/lib/db";
import {
  BudgetRow,
  BudgetStatus,
  budgetAlertLines,
  computeBudgetStatus,
} from "@/lib/finance/budget-math";
import { CATEGORIES, type Category } from "@/lib/finance/categorize";

// Category budgets: one optional monthly limit per fixed transaction
// category. Reads/writes here; the arithmetic lives in budget-math.ts.

export function listBudgets(): BudgetRow[] {
  return getDb()
    .prepare("SELECT category, monthly_limit FROM category_budgets ORDER BY category")
    .all() as BudgetRow[];
}

// limit=null clears the budget for that category.
export function setBudget(category: Category, limit: number | null): void {
  const db = getDb();
  if (limit == null) {
    db.prepare("DELETE FROM category_budgets WHERE category = ?").run(category);
    return;
  }
  db.prepare(
    `INSERT INTO category_budgets (category, monthly_limit) VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`
  ).run(category, limit);
}

// Month-to-date spend per category (money out only), keyed by category.
export function mtdSpendByCategory(month?: string): Record<string, number> {
  const ym = month ?? new Date().toISOString().slice(0, 7);
  const rows = getDb()
    .prepare(
      `SELECT category, SUM(-amount) AS spent FROM transactions
       WHERE amount < 0 AND substr(date, 1, 7) = ? GROUP BY category`
    )
    .all(ym) as Array<{ category: string; spent: number }>;
  return Object.fromEntries(rows.map((r) => [r.category, r.spent]));
}

export function budgetStatus(): BudgetStatus[] {
  return computeBudgetStatus(listBudgets(), mtdSpendByCategory());
}

// The deterministic lines the morning brief prints; [] when all under 80%.
export function budgetAlerts(): string[] {
  return budgetAlertLines(budgetStatus());
}

export { CATEGORIES };
