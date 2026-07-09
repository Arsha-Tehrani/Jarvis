import assert from "node:assert/strict";
import { test } from "node:test";
import { transactionsForTab, unclassifiedCount, type TabbableTransaction } from "../lib/finance/finance-tabs.ts";

// A set spanning all four sub-types plus one unbadged transaction -- the
// exact scenario the Phase 4 plan calls for.
const SAMPLE: (TabbableTransaction & { id: number })[] = [
  { id: 1, account_type: "checking", category: "Groceries" },
  { id: 2, account_type: "savings", category: "Income" },
  { id: 3, account_type: "credit_card", category: "Dining" },
  { id: 4, account_type: "investment", category: "Uncategorized" },
  { id: 5, account_type: "checking", category: "Investment" }, // ACH into brokerage
  { id: 6, account_type: null, category: "Other" }, // unclassified
];

test("checking tab includes both checking and savings account_type rows", () => {
  // id 5 is account_type "checking" categorized "Investment" (an ACH transfer
  // OUT of checking into brokerage) -- it's a real checking-account row, so
  // it correctly appears here too. It also appears in the investment tab
  // below; the two tabs are not mutually exclusive by design (an ACH
  // transfer is real activity on both the source account and "what's
  // happening with my investing").
  const ids = transactionsForTab(SAMPLE, "checking").map((t) => t.id);
  assert.deepEqual(ids, [1, 2, 5]);
});

test("credit_card tab includes only credit_card rows", () => {
  const ids = transactionsForTab(SAMPLE, "credit_card").map((t) => t.id);
  assert.deepEqual(ids, [3]);
});

test("investment tab includes investment-typed rows AND Investment-category rows regardless of account type", () => {
  const ids = transactionsForTab(SAMPLE, "investment").map((t) => t.id);
  assert.deepEqual(ids, [4, 5]);
});

test("total tab includes every row, including the unclassified one", () => {
  const ids = transactionsForTab(SAMPLE, "total").map((t) => t.id);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6]);
});

test("unclassifiedCount reports exactly the null-account_type rows", () => {
  assert.equal(unclassifiedCount(SAMPLE), 1);
});

test("total tab's row count matches the full input length (regression guard: this refactor must not change Total's math)", () => {
  assert.equal(transactionsForTab(SAMPLE, "total").length, SAMPLE.length);
});

test("empty input produces empty output for every tab, never a crash", () => {
  for (const tab of ["checking", "credit_card", "investment", "total"] as const) {
    assert.deepEqual(transactionsForTab([], tab), []);
  }
  assert.equal(unclassifiedCount([]), 0);
});
