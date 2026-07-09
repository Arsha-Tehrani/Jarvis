import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrokerageStatementError,
  extractStatementBalance,
  groupRecords,
  inferPeriodEnd,
  isBrokerageStatement,
  parsePdfText,
} from "../lib/finance/parse.ts";

// Fixtures mirror the real Chase checking + credit-card layouts that pdfjs
// extracts (see the investigation): checking has a DATE/DESC/AMOUNT/BALANCE
// running balance, the credit card has a single trailing amount, and a
// Fidelity report has no transaction structure at all.

const CHECKING = `
Chase Total Checking
Statement Period through 06/30/2026
DATE DESCRIPTION AMOUNT BALANCE
Beginning Balance $4,573.81
05/29 Fid Bkg Svc LLC Moneyline PPD ID: 0368004600 -33.00 4,540.81
06/01 Applecard Gsbank Payment Web ID: 9999999999 -168.08 4,372.73
06/02 06/02 Payment To Chase Card Ending IN 9749 -300.00 4,072.73
06/03 Zelle Payment From Vedant Ray Pncaa0Aek50M 4,076.73
06/09 Card Purchase 06/08 Sebco Laundry Technol 732-752-9000 NJ Card
8632 -30.00 4,046.73
Ending Balance $4,046.73
`;

const CREDIT_CARD = `
Chase Freedom
Opening/Closing Date 05/17/26 - 06/16/26
Minimum Payment Due: $40.00
New Balance: $249.24
05/16 Payment Thank You-Mobile -239.15
05/16 RACEWAY 2334 MORRIS PLAINS NJ 54.14
06/07 VERIZON BILL PAYMENT VERIZON.COM FL 69.98
06/13 AMAZON MKTPLACE PMTS Amzn.com/bill WA -14.92
`;

const BROKERAGE = `
INVESTMENT REPORT
June 1, 2026 - June 30, 2026
FIDELITY ACCOUNT
Your Account Value: $19,214.47
Beginning Account Value $19,091.87
Ending Account Value $19,214.47
LUMENTUM HLDGS INC COM 55024U109 100.000 39.55 3,955.00
`;

test("inferPeriodEnd reads the statement period, not a random number", () => {
  assert.deepEqual(inferPeriodEnd(CHECKING), { year: 2026, month: 6 });
  // Credit card: latest header date is the 07/13/26-style due area or the
  // 06/16/26 close — either way 2026, month >= 6.
  assert.equal(inferPeriodEnd(CREDIT_CARD).year, 2026);
});

test("groupRecords joins wrapped description lines into one record", () => {
  const records = groupRecords(CHECKING.split("\n"));
  const wrapped = records.find((r) => r.month === 6 && r.day === 9);
  assert.ok(wrapped, "06/09 record exists");
  assert.ok(wrapped!.text.includes("Sebco Laundry"));
  assert.ok(wrapped!.text.includes("8632 -30.00 4,046.73"), "wrap line absorbed");
});

test("checking: amounts come from the balance delta, not the balance column", () => {
  const rows = parsePdfText(CHECKING);
  const byDay = (mmdd: string) => rows.find((r) => r.date === mmdd);

  // -33.00 debit, NOT the 4,540.81 balance the old parser grabbed.
  assert.equal(byDay("2026-05-29")?.amount, -33.0);
  assert.equal(byDay("2026-06-01")?.amount, -168.08);
  // Deposit line printed ONLY a balance (4,076.73) — delta recovers +4.00.
  assert.equal(byDay("2026-06-03")?.amount, 4.0);
  // Wrapped multi-line purchase resolves to its real amount.
  assert.equal(byDay("2026-06-09")?.amount, -30.0);
  // Real year applied — never 2001.
  assert.ok(rows.every((r) => r.date.startsWith("2026-")));
});

test("checking: descriptions are readable and account digits redacted", () => {
  const rows = parsePdfText(CHECKING);
  const apple = rows.find((r) => r.date === "2026-06-01");
  assert.ok(apple!.raw_description.includes("Applecard Gsbank"));
  assert.ok(!/\d{8,}/.test(apple!.raw_description), "long digit runs masked");
  assert.ok(!/-?\d[\d,]*\.\d{2}\s*$/.test(apple!.raw_description), "trailing money stripped");
});

test("credit card: purchases become money-out, payments become money-in", () => {
  const rows = parsePdfText(CREDIT_CARD);
  // Purchase printed +54.14 → spending, so negative.
  const raceway = rows.find((r) => r.raw_description.includes("RACEWAY"));
  assert.equal(raceway?.amount, -54.14);
  // A real Verizon bill on the card stays a normal purchase (money out).
  const verizon = rows.find((r) => r.raw_description.includes("VERIZON"));
  assert.equal(verizon?.amount, -69.98);
  // Payment printed -239.15 → money in (flipped), will categorize as Transfer.
  const payment = rows.find((r) => r.raw_description.includes("Payment Thank You"));
  assert.equal(payment?.amount, 239.15);
  // Refund printed -14.92 → money in.
  const refund = rows.find((r) => r.raw_description.includes("AMAZON"));
  assert.equal(refund?.amount, 14.92);
});

test("a full MM/DD/YY metadata date is not backtracked into a bogus transaction", () => {
  // Regression: "07/13/26" (an AutoPay due date) once matched as 07/1 and
  // leaked "3/26" + a nearby $40.00 as a phantom -$40 transaction.
  const withDueDate = `
Opening/Closing Date 05/17/26 - 06/16/26
07/13/26
$249.24
$40.00
05/16 RACEWAY 2334 MORRIS PLAINS NJ 54.14
`;
  const rows = parsePdfText(withDueDate);
  assert.equal(rows.length, 1, "only the real purchase is a transaction");
  assert.equal(rows[0].raw_description.includes("RACEWAY"), true);
  assert.ok(!rows.some((r) => r.raw_description.trim() === "3/26"));
});

test("brokerage/investment reports are detected and refused, not mis-parsed", () => {
  assert.equal(isBrokerageStatement(BROKERAGE), true);
  assert.equal(isBrokerageStatement(CHECKING), false);
  assert.equal(isBrokerageStatement(CREDIT_CARD), false);
  assert.throws(() => parsePdfText(BROKERAGE), BrokerageStatementError);
});

test("extractStatementBalance reads the summary balance and its kind", () => {
  // Checking: last "Ending Balance" → a cash asset.
  assert.deepEqual(extractStatementBalance(CHECKING), {
    balance: 4046.73,
    kind: "cash",
    label: "Checking",
  });
  // Credit card: "New Balance" alongside "Minimum Payment Due" → a debt.
  assert.deepEqual(extractStatementBalance(CREDIT_CARD), {
    balance: 249.24,
    kind: "debt",
    label: "Credit Card",
  });
  // Nothing to suggest when there's no summary line.
  assert.equal(extractStatementBalance("just some text, no balance here"), null);
});

test("extractStatementBalance labels with the classified account sub-type, not a hardcoded default", () => {
  // A savings statement has the exact same "Ending Balance" structure as
  // checking — without a sub-type label, it would collide with a checking
  // suggestion under the same generic "Checking" label. Passing the
  // classifier's actual sub-type (as ingest.ts now does) fixes that.
  assert.deepEqual(extractStatementBalance(CHECKING, "Savings"), {
    balance: 4046.73,
    kind: "cash",
    label: "Savings",
  });
  assert.deepEqual(extractStatementBalance(CREDIT_CARD, "Credit Card"), {
    balance: 249.24,
    kind: "debt",
    label: "Credit Card",
  });
  // No override → the old hardcoded defaults, for content-ambiguous imports.
  assert.equal(extractStatementBalance(CHECKING)?.label, "Checking");
});

test("cross-year: a December line on a January statement lands in the prior year", () => {
  const janStatement = `
Statement Period through 01/15/2026
DATE DESCRIPTION AMOUNT BALANCE
Beginning Balance $1,000.00
12/28 Some Store Purchase -50.00 950.00
01/03 Another Purchase -25.00 925.00
`;
  const rows = parsePdfText(janStatement);
  assert.equal(rows.find((r) => r.raw_description.includes("Some Store"))?.date, "2025-12-28");
  assert.equal(rows.find((r) => r.raw_description.includes("Another"))?.date, "2026-01-03");
});
