// Detects one real-world payment appearing as TWO transaction rows across two
// different accounts — the classic case being a credit-card payment: an
// outflow on the checking statement and a matching credit on the card
// statement. Without this, both rows count as real spend/income and the same
// dollar amount is counted twice.
//
// Pure, DB-free, unit-tested with concrete inputs like every other
// deterministic finance module — the caller (lib/finance/ingest.ts) reads
// rows from SQLite, calls this, and writes category='Transfer' on the ids
// returned (the same category value lib/finance/analyze.ts's NON_SPEND
// already excludes from spend/income totals, so no new plumbing is needed
// downstream — just a more reliable way to reach that category than hoping
// a bank's exact wording matches a keyword rule).

export type TransferCandidate = {
  id: number;
  date: string; // YYYY-MM-DD
  amount: number;
  raw_description: string;
  statement_id: number;
};

// At least one side must read like a payment/transfer — otherwise two
// unrelated transactions that happen to share an amount (e.g. two identical
// grocery runs on different accounts) would wrongly match. Deliberately
// broader than categorize-rules.ts's keyword list (e.g. matches
// "PAYMENT - THANK YOU" with a hyphen, which that list's exact-phrase
// "PAYMENT THANK YOU" misses) since this only needs to hint "transfer-shaped",
// not assign the final category.
const TRANSFER_HINT =
  /PAYMENT\s*-?\s*THANK YOU|AUTOPAY|ONLINE\s*PMT|E-?PAYMENT|PAYMENT\s+(TO|FROM)|CARD\s*PAYMENT|\bXFER\b|TRANSFER|ACH\s+(PAYMENT|TRANSFER)/i;

// Same real-world payment posts a day or two apart on each account in
// practice; 5 days gives slack without being so wide it matches unrelated
// transactions. A stated non-goal: two $50 charges 40 days apart must NOT match.
const MAX_DAYS_APART = 5;

// Returns the ids of every row that's part of a matched transfer pair.
// Greedy pairing (first candidate match wins) is fine here: a false-negative
// (a real pair left uncategorized as Transfer) is a minor annoyance you can
// fix by hand; a false-positive (marking real spend as a transfer) hides it
// from budgets, which is the failure mode this function must avoid.
//
// Rows are bucketed by exact-cent absolute amount first (a real transfer
// pair always shares one), so a multi-year transaction history only compares
// same-amount rows to each other instead of every row to every row.
export function findTransferPairs(rows: TransferCandidate[]): number[] {
  const byAbsAmount = new Map<number, TransferCandidate[]>();
  for (const row of rows) {
    if (row.amount === 0) continue;
    const key = Math.round(Math.abs(row.amount) * 100);
    const group = byAbsAmount.get(key);
    if (group) group.push(row);
    else byAbsAmount.set(key, [row]);
  }

  const matched = new Set<number>();
  for (const group of byAbsAmount.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      if (matched.has(a.id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        if (matched.has(b.id)) continue;
        if (a.statement_id === b.statement_id) continue; // must be cross-account
        if (a.amount > 0 === b.amount > 0) continue; // same magnitude already; need opposite sign
        const daysApart = Math.abs(Date.parse(a.date) - Date.parse(b.date)) / 86_400_000;
        if (Number.isNaN(daysApart) || daysApart > MAX_DAYS_APART) continue;
        if (!TRANSFER_HINT.test(a.raw_description) && !TRANSFER_HINT.test(b.raw_description)) continue;
        matched.add(a.id);
        matched.add(b.id);
        break;
      }
    }
  }
  return [...matched];
}
