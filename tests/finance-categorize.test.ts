import assert from "node:assert/strict";
import { test } from "node:test";
import {
  categorizeByRules,
  categoryReference,
  explainCategory,
  forcedCategory,
  matchedRule,
} from "../lib/finance/categorize-rules.ts";

// The real Fidelity ACH descriptor — the one the model mislabeled as a generic
// Transfer, zeroing out "Amount Invested". The weekly amount grows (33→34→…),
// so matching must key off text, never amount.
const FIDELITY_ACH = "Fid Bkg Svc LLC Moneyline PPD ID: ••••4600";

test("brokerage ACH transfers force the Investment category regardless of amount", () => {
  assert.equal(forcedCategory(FIDELITY_ACH), "Investment");
  // Same descriptor, different (growing) amounts — still Investment every time.
  for (const amt of [-33, -34, -35, -36, -250.75]) {
    assert.equal(categorizeByRules(FIDELITY_ACH, amt), "Investment");
  }
  // Other common brokerage wordings.
  assert.equal(forcedCategory("ACH WEB VANGUARD BUY"), "Investment");
  assert.equal(forcedCategory("NETXINVEST TRANSFER"), "Investment");
});

test("a non-brokerage transfer is NOT forced to Investment", () => {
  assert.equal(forcedCategory("Zelle payment to roommate"), null);
  assert.equal(categorizeByRules("Zelle payment to roommate", -50), "Transfer");
});

test("keyword rules still classify ordinary merchants", () => {
  assert.equal(categorizeByRules("WHOLE FOODS MARKET", -40), "Groceries");
  assert.equal(categorizeByRules("STARBUCKS STORE 123", -6), "Dining");
  assert.equal(categorizeByRules("Mystery vendor", -10), "Other");
  assert.equal(categorizeByRules("Mystery deposit", 500), "Income");
});

test("explainCategory reports the matched keyword or the model", () => {
  // Forced brokerage match names the descriptor keyword.
  const inv = explainCategory(FIDELITY_ACH, "Investment");
  assert.equal(inv.source, "keyword");
  assert.ok(inv.source === "keyword" && /MONEYLINE|Fid Bkg/i.test(inv.keyword));
  // Keyword rule match names the merchant token.
  const groc = explainCategory("WHOLE FOODS MARKET", "Groceries");
  assert.equal(groc.source, "keyword");
  // A category the rules can't explain → attributed to the model.
  assert.equal(explainCategory("WHOLE FOODS MARKET", "Travel").source, "model");
});

test("matchedRule surfaces the exact substring that matched", () => {
  const m = matchedRule("UBER EATS delivery");
  assert.equal(m?.category, "Dining");
});

test("categoryReference is generated from the real rules and covers all 15", () => {
  const ref = categoryReference();
  assert.equal(ref.length, 15);
  const groceries = ref.find((r) => r.category === "Groceries");
  assert.ok(groceries && groceries.keywords.some((k) => /WHOLE FOODS|COSTCO|GROCERY/i.test(k)));
  const investment = ref.find((r) => r.category === "Investment");
  assert.ok(investment && investment.keywords.length > 0);
});
