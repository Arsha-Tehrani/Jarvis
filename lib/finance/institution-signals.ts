// Per-institution/per-document-type wording signals for lib/finance/classify.ts.
//
// Everything classify.ts decides STRUCTURALLY (holding rows that pass the
// qty×price arithmetic self-check, dated running-balance transaction rows,
// CSV column shapes) already generalizes across institutions for free — that
// was true before this file existed and stays true. What doesn't generalize
// is WORDING: which phrase a given bank/brokerage prints to say "this is a
// checking account" or "this is a brokerage statement". Before this file,
// those phrases were five hardcoded regexes in classify.ts, so supporting a
// new institution's wording meant editing scoring code. Now it's a data
// table: adding a bank/brokerage means appending rows here, never touching
// classify.ts's decision logic.
//
// Each row is boolean (present/absent) rather than weighted — classify.ts's
// confidence gradation already comes from structural counts (how many
// holding rows, how many transaction rows), not from summing signal weights,
// so a numeric per-row weight would add complexity without changing any
// decision. See docs/multi-institution-parsing.md for the fuller writeup.

export type SignalTag =
  | "brokerage_header" // this document is a brokerage/investment statement
  | "transaction_header" // this document is a bank/card transaction statement
  | "credit_card" // the transaction statement is FOR a credit card
  | "savings" // the transaction statement is FOR a savings account
  | "checking"; // the transaction statement is FOR a checking account

export type SignalRow = {
  // Which bank/brokerage this wording is known to come from. Purely
  // documentation/provenance — not read by the scorer — so it's obvious at a
  // glance which institution a given row exists for.
  institution: string;
  tag: SignalTag;
  pattern: RegExp;
};

export const SIGNAL_TABLE: SignalRow[] = [
  // --- Generic bank/card wording (works across most US banks) ---
  { institution: "generic bank", tag: "transaction_header", pattern: /DATE\s+DESCRIPTION\s+AMOUNT\s+BALANCE/i },
  { institution: "generic bank", tag: "transaction_header", pattern: /Beginning Balance\s*\$?[\d,]+\.\d{2}/i },
  { institution: "generic bank", tag: "transaction_header", pattern: /Payment Due Date/i },
  { institution: "generic credit card", tag: "transaction_header", pattern: /Minimum Payment Due/i },
  { institution: "generic credit card", tag: "credit_card", pattern: /Minimum Payment Due/i },
  { institution: "generic credit card", tag: "credit_card", pattern: /New Balance:?\s*\$/i },
  { institution: "generic credit card", tag: "credit_card", pattern: /Credit Limit/i },
  { institution: "generic credit card", tag: "credit_card", pattern: /Available Credit/i },
  { institution: "generic credit card", tag: "credit_card", pattern: /Payment Due Date/i },
  { institution: "generic bank", tag: "checking", pattern: /DATE\s+DESCRIPTION\s+AMOUNT\s+BALANCE/i },
  { institution: "generic bank", tag: "checking", pattern: /Beginning Balance\s*\$?[\d,]+\.\d{2}/i },
  { institution: "generic bank", tag: "checking", pattern: /Ending Balance\s*\$?[\d,]+\.\d{2}/i },
  { institution: "generic bank", tag: "checking", pattern: /Checking Account/i },
  { institution: "Chase", tag: "checking", pattern: /Total Checking/i },
  // Header-style phrases only — deliberately NOT a bare "Savings Account"
  // match. See classify.ts / Phase 2: a real Chase checking statement's
  // standard overdraft-protection disclosure reads "...a link to a Chase
  // savings account...", referring to a DIFFERENT, linked account. These
  // phrases only appear as a statement's own account-type header.
  { institution: "generic bank", tag: "savings", pattern: /Regular Savings/i },
  { institution: "generic bank", tag: "savings", pattern: /Statement Savings/i },
  { institution: "generic bank", tag: "savings", pattern: /Total Savings/i },
  { institution: "generic bank", tag: "savings", pattern: /Savings Summary/i },

  // --- Generic brokerage wording ---
  { institution: "generic brokerage", tag: "brokerage_header", pattern: /INVESTMENT REPORT/i },
  { institution: "generic brokerage", tag: "brokerage_header", pattern: /Your Account Value/i },
  { institution: "generic brokerage", tag: "brokerage_header", pattern: /Ending Account Value/i },
  { institution: "generic brokerage", tag: "brokerage_header", pattern: /Holdings?\s+as of/i },
  { institution: "generic brokerage", tag: "brokerage_header", pattern: /Positions?\s+as of/i },
  { institution: "generic brokerage", tag: "brokerage_header", pattern: /Realized Gain\/Loss/i },
  { institution: "generic brokerage", tag: "brokerage_header", pattern: /Symbol\/?\s*CUSIP/i },
  { institution: "Fidelity", tag: "brokerage_header", pattern: /Brokerage services provided/i },

  // --- New institutions added this phase, to prove the table is genuinely
  // extensible: "add a bank" is a data change, not a code change. ---
  { institution: "Second National Bank", tag: "transaction_header", pattern: /Second National Bank/i },
  { institution: "Second National Bank", tag: "checking", pattern: /Second National (Free )?Checking/i },
  { institution: "Second National Bank", tag: "savings", pattern: /Second National Savings/i },
  { institution: "Summit Brokerage", tag: "brokerage_header", pattern: /Summit Brokerage/i },
];

export function tagMatches(text: string, tag: SignalTag): boolean {
  return SIGNAL_TABLE.some((row) => row.tag === tag && row.pattern.test(text));
}
