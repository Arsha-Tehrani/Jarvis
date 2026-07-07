// Pure budget arithmetic — no db/network imports so `node --test` hits it
// directly. Deterministic by design: the morning brief's budget lines come
// straight from here, no LLM involved.

export type BudgetRow = { category: string; monthly_limit: number };

export type BudgetStatus = {
  category: string;
  limit: number;
  spent: number;
  fraction: number; // spent/limit, NOT clamped (1.4 = 40% over)
  state: "ok" | "warning" | "over";
};

// Warn when month-to-date spend crosses this share of the monthly limit.
export const WARNING_FRACTION = 0.8;

export function computeBudgetStatus(
  budgets: BudgetRow[],
  spendByCategory: Record<string, number>
): BudgetStatus[] {
  return budgets
    .filter((b) => b.monthly_limit > 0)
    .map((b) => {
      const spent = spendByCategory[b.category] ?? 0;
      const fraction = spent / b.monthly_limit;
      return {
        category: b.category,
        limit: b.monthly_limit,
        spent,
        fraction,
        state: fraction > 1 ? "over" : fraction >= WARNING_FRACTION ? "warning" : "ok",
      } as BudgetStatus;
    })
    .sort((a, b) => b.fraction - a.fraction);
}

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

// One brief-ready line per at-risk category; empty when everything is fine.
export function budgetAlertLines(statuses: BudgetStatus[]): string[] {
  const lines: string[] = [];
  for (const s of statuses) {
    if (s.state === "over") {
      lines.push(
        `${s.category} is over budget: ${usd(s.spent)} of ${usd(s.limit)} (${Math.round(s.fraction * 100)}%)`
      );
    } else if (s.state === "warning") {
      lines.push(
        `${s.category} at ${Math.round(s.fraction * 100)}% of budget (${usd(s.spent)} of ${usd(s.limit)})`
      );
    }
  }
  return lines;
}
