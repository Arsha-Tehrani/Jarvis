import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyStatementText,
  classifyStatementTable,
  CONFIDENCE_FLOOR,
} from "../lib/finance/classify.ts";
import { validateHoldings } from "../lib/finance/holdings-schema.ts";
import { parseCsv } from "../lib/finance/parse.ts";

// Small, hand-constructed fixtures that mirror what pdfjs extracts. The point
// of the classifier is that the SAME data lands on the same `kind` whether it
// arrives as a PDF or a CSV, and that a file we can't confidently parse is
// rejected (confidence < floor) rather than mis-imported.

// --- PDF text fixtures ---

const BANK_CHECKING_PDF = `
Chase Total Checking
Statement Period through 06/30/2026
DATE DESCRIPTION AMOUNT BALANCE
Beginning Balance $4,573.81
05/29 Fid Bkg Svc LLC Moneyline PPD ID: 0368004600 -33.00 4,540.81
06/01 Applecard Gsbank Payment Web ID: 9999999999 -168.08 4,372.73
06/13 Grocery Store Purchase -52.10 4,320.63
Ending Balance $4,320.63
`;

const CREDIT_CARD_PDF = `
Chase Freedom
Opening/Closing Date 05/17/26 - 06/16/26
Minimum Payment Due: $40.00
New Balance: $249.24
05/16 RACEWAY 2334 MORRIS PLAINS NJ 54.14
06/07 VERIZON BILL PAYMENT VERIZON.COM FL 69.98
06/13 AMAZON MKTPLACE PMTS Amzn.com/bill WA 14.92
`;

// Brokerage holding rows self-check as qty*price == market value, so they're
// recognized structurally even without leaning on the letterhead text.
const BROKERAGE_PDF = `
INVESTMENT REPORT
June 1, 2026 - June 30, 2026
FIDELITY ACCOUNT
Symbol/CUSIP Description Quantity Price Market Value Cost Basis Unrealized
MICROSOFT CORP (MSFT) 450.24 2.000 373.0200 746.04 770.47 -24.43 7.28
ALPHABET INC CAP STK CL A(GOOGL) 760.68 2.000 357.3700 714.74 694.80 19.94 1.76
NIKE INC CLASS B COM NPV(NKE) 323.61 7.000 41.0500 287.35 456.40 -169.05 11.48
`;

// A brokerage report whose holdings table can't be extracted (values don't
// line up) — letterhead only. Must be low-confidence, i.e. rejected.
const BROKERAGE_UNPARSEABLE_PDF = `
INVESTMENT REPORT
Your Account Value: $19,214.47
Beginning Account Value $19,091.87
Ending Account Value $19,214.47
(May not reflect all gains and losses due to incomplete cost basis)
`;

test("bank checking PDF classifies as a transaction statement", () => {
  const c = classifyStatementText(BANK_CHECKING_PDF);
  assert.equal(c.kind, "transaction");
  assert.ok(c.confidence >= CONFIDENCE_FLOOR);
});

test("credit-card PDF classifies as a transaction statement", () => {
  const c = classifyStatementText(CREDIT_CARD_PDF);
  assert.equal(c.kind, "transaction");
  assert.ok(c.confidence >= CONFIDENCE_FLOOR);
});

// --- account sub-type: the actual Part A follow-up fix. A checking and a
// credit-card statement both used to land in the same generic "transaction"
// bucket with nothing distinguishing them; these fixtures assert they now
// score distinct sub-kinds from content alone (never the filename).

test("bank checking PDF sub-classifies as checking, not credit card", () => {
  const c = classifyStatementText(BANK_CHECKING_PDF);
  assert.equal(c.subKind, "checking");
  assert.ok(!c.subKindConflict);
});

test("credit-card PDF sub-classifies as credit_card, not checking", () => {
  const c = classifyStatementText(CREDIT_CARD_PDF);
  assert.equal(c.subKind, "credit_card");
  assert.ok(!c.subKindConflict);
});

const SAVINGS_PDF = `
Chase Savings
Regular Savings Account Summary
DATE DESCRIPTION AMOUNT BALANCE
Beginning Balance $10,000.00
06/15 Interest Payment 4.12 10,004.12
Ending Balance $10,004.12
`;

test("savings PDF sub-classifies as savings, not checking", () => {
  const c = classifyStatementText(SAVINGS_PDF);
  assert.equal(c.kind, "transaction");
  assert.equal(c.subKind, "savings");
  assert.ok(!c.subKindConflict);
});

// A statement can't honestly be both a credit card and a checking account —
// this fixture forces both signals to fire, which must be flagged as a
// conflict (rejected upstream in ingest.ts) rather than guessed.
const CONFLICTING_PDF = `
Chase Total Checking
DATE DESCRIPTION AMOUNT BALANCE
Beginning Balance $500.00
Minimum Payment Due: $25.00
New Balance: $500.00
06/01 Some Charge -25.00 475.00
Ending Balance $475.00
`;

test("statement with both credit-card and checking signals is flagged as a conflict", () => {
  const c = classifyStatementText(CONFLICTING_PDF);
  assert.equal(c.kind, "transaction");
  assert.equal(c.subKind, undefined);
  assert.ok(c.subKindConflict);
});

test("generic CSV with no distinguishing content is imported unlabeled, not rejected", () => {
  const table = parseCsv("Date,Description,Amount\n2026-06-01,COFFEE,-4.50\n2026-06-02,PAYCHECK,2000\n");
  const c = classifyStatementTable(table);
  assert.equal(c.kind, "transaction");
  assert.equal(c.subKind, undefined);
  assert.ok(!c.subKindConflict);
  assert.ok(c.confidence >= CONFIDENCE_FLOOR); // still importable — just unbadged
});

test("CSV with a running-balance column sub-classifies as checking", () => {
  const table = parseCsv(
    "Date,Description,Amount,Balance\n2026-06-01,COFFEE,-4.50,995.50\n2026-06-02,PAYCHECK,2000,2995.50\n"
  );
  const c = classifyStatementTable(table);
  assert.equal(c.subKind, "checking");
});

test("CSV with credit-card wording sub-classifies as credit_card", () => {
  const table = parseCsv(
    "Date,Description,Amount\n2026-06-01,AMAZON,-14.92\nMinimum Payment Due,,40.00\n"
  );
  const c = classifyStatementTable(table);
  assert.equal(c.subKind, "credit_card");
});

test("brokerage PDF classifies as brokerage via consistent holding rows", () => {
  const c = classifyStatementText(BROKERAGE_PDF);
  assert.equal(c.kind, "brokerage");
  assert.ok(c.confidence >= CONFIDENCE_FLOOR);
  assert.ok(c.signals.some((s) => /holding row/.test(s)));
});

test("brokerage letterhead with no extractable holdings is rejected (low confidence)", () => {
  const c = classifyStatementText(BROKERAGE_UNPARSEABLE_PDF);
  // It's recognized as brokerage-shaped, but we can't parse it, so confidence
  // must fall below the floor — the caller turns this into a visible rejection
  // rather than importing zeroed holdings.
  assert.ok(c.confidence < CONFIDENCE_FLOOR, `confidence was ${c.confidence}`);
});

test("garbage text classifies as unknown and is rejected", () => {
  const c = classifyStatementText("just some notes to self, nothing financial here");
  assert.equal(c.kind, "unknown");
  assert.ok(c.confidence < CONFIDENCE_FLOOR);
});

// --- CSV fixtures: same verdicts as the PDF paths ---

test("brokerage positions CSV classifies as brokerage", () => {
  const table = parseCsv("Symbol,Quantity,Average Cost Basis\nVOO,10,420.50\nAAPL,15,177.42\n");
  const c = classifyStatementTable(table);
  assert.equal(c.kind, "brokerage");
  assert.ok(c.confidence >= CONFIDENCE_FLOOR);
});

test("bank CSV classifies as a transaction statement", () => {
  const table = parseCsv("Date,Description,Amount\n2026-06-01,COFFEE,-4.50\n2026-06-02,PAYCHECK,2000\n");
  const c = classifyStatementTable(table);
  assert.equal(c.kind, "transaction");
  assert.ok(c.confidence >= CONFIDENCE_FLOOR);
});

test("CSV with unrecognized columns is rejected", () => {
  const table = parseCsv("Foo,Bar\n1,2\n");
  const c = classifyStatementTable(table);
  assert.equal(c.kind, "unknown");
  assert.ok(c.confidence < CONFIDENCE_FLOOR);
});

// --- holdings schema gate ---

test("validateHoldings drops malformed rows and warns, keeps zero cost basis", () => {
  const { holdings, warnings } = validateHoldings([
    { ticker: "MSFT", shares: 2, cost_basis: 385.24 },
    { ticker: "", shares: 5, cost_basis: 10 }, // blank ticker → dropped
    { ticker: "TSLA", shares: -3, cost_basis: 100 }, // negative shares → dropped
    { ticker: "SPAXX", shares: 231.47, cost_basis: 0 }, // kept, warned
  ]);
  assert.deepEqual(
    holdings.map((h) => h.ticker),
    ["MSFT", "SPAXX"]
  );
  assert.equal(warnings.length, 3); // blank, negative, and the zero-cost soft warning
  assert.ok(warnings.some((w) => /SPAXX/.test(w) && /cost basis/.test(w)));
});
