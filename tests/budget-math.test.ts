import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetAlertLines,
  computeBudgetStatus,
} from "../lib/finance/budget-math.ts";

const budgets = [
  { category: "Dining", monthly_limit: 300 },
  { category: "Groceries", monthly_limit: 500 },
  { category: "Entertainment", monthly_limit: 100 },
];

test("under 80% is ok, 80%+ warns, over 100% flags an overage", () => {
  const status = computeBudgetStatus(budgets, {
    Dining: 150, // 50% → ok
    Groceries: 400, // 80% → warning (boundary inclusive)
    Entertainment: 140, // 140% → over
  });
  const byCat = Object.fromEntries(status.map((s) => [s.category, s]));
  assert.equal(byCat.Dining.state, "ok");
  assert.equal(byCat.Groceries.state, "warning");
  assert.equal(byCat.Entertainment.state, "over");
});

test("exactly at the limit is still 'warning', a cent over is 'over'", () => {
  const [atLimit] = computeBudgetStatus([budgets[0]], { Dining: 300 });
  assert.equal(atLimit.state, "warning");
  const [over] = computeBudgetStatus([budgets[0]], { Dining: 300.01 });
  assert.equal(over.state, "over");
});

test("categories with no spend yet are ok at 0", () => {
  const [s] = computeBudgetStatus([budgets[0]], {});
  assert.equal(s.spent, 0);
  assert.equal(s.state, "ok");
});

test("statuses sort worst-first and fraction is not clamped", () => {
  const status = computeBudgetStatus(budgets, {
    Dining: 30,
    Groceries: 450,
    Entertainment: 140,
  });
  assert.deepEqual(
    status.map((s) => s.category),
    ["Entertainment", "Groceries", "Dining"]
  );
  assert.equal(status[0].fraction, 1.4);
});

test("alert lines: only warning/over produce lines, with amounts and percent", () => {
  const status = computeBudgetStatus(budgets, {
    Dining: 150,
    Groceries: 400,
    Entertainment: 140,
  });
  const lines = budgetAlertLines(status);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Entertainment is over budget: \$140 of \$100 \(140%\)/);
  assert.match(lines[1], /Groceries at 80% of budget \(\$400 of \$500\)/);
});

test("no budgets or all-ok means zero alert lines (quiet brief)", () => {
  assert.deepEqual(budgetAlertLines(computeBudgetStatus([], {})), []);
  assert.deepEqual(
    budgetAlertLines(computeBudgetStatus(budgets, { Dining: 10 })),
    []
  );
});
