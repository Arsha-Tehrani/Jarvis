// Known cash-equivalent (money-market / cash-sweep) fund tickers, used to
// SEED the default classification for a holding — same convention as
// lib/finance/institution-signals.ts's flat data table: adding a new fund
// family means appending a row here, never touching scoring/branching logic
// elsewhere. This is a starting default, not an authority: the seeded value
// lives on `holdings.is_cash_equivalent` (a real, per-holding, user-
// overridable column) and is only ever consulted once, at seed time — never
// re-derived from this table on render, so a manual correction always sticks.
//
// A cash-equivalent fund functions as cash inside a brokerage account (no
// meaningful day-move, ~stable $1 NAV) rather than an equity position with a
// real market price — SPAXX (Fidelity's default core position) is the
// canonical example already called out elsewhere in this app as the
// cost-basis-fallback case (no live quote).

export type CashEquivalentRow = {
  ticker: string;
  fund: string;
  institution: string;
};

export const CASH_EQUIVALENT_TABLE: CashEquivalentRow[] = [
  { ticker: "SPAXX", fund: "Government Money Market", institution: "Fidelity" },
  { ticker: "FDRXX", fund: "Government Cash Reserves", institution: "Fidelity" },
  { ticker: "FZFXX", fund: "Treasury Money Market", institution: "Fidelity" },
  { ticker: "SPRXX", fund: "Money Market Fund", institution: "Fidelity" },
  { ticker: "VMFXX", fund: "Federal Money Market Fund", institution: "Vanguard" },
  { ticker: "VMRXX", fund: "Cash Reserves Federal Money Market", institution: "Vanguard" },
  { ticker: "SWVXX", fund: "Value Advantage Money Fund", institution: "Schwab" },
  { ticker: "SNVXX", fund: "Government Money Fund", institution: "Schwab" },
];

const KNOWN_TICKERS = new Set(CASH_EQUIVALENT_TABLE.map((r) => r.ticker));

/** Case-insensitive lookup against the seed table. Pure, no DB/network. */
export function isKnownCashEquivalent(ticker: string): boolean {
  return KNOWN_TICKERS.has(ticker.toUpperCase());
}

export type ValuedHolding = {
  value: number;
  // SQLite gives back 0/1 for the stored column; also accept a real boolean
  // so callers building test fixtures don't have to think about the DB shape.
  is_cash_equivalent: boolean | number;
};

// The snapshot's stocks_value/cash_equivalent_value split: sums each
// already-valued holding (from computePortfolioTotal) into one bucket or the
// other by its persisted classification. Pure — no DB/network — so the daily
// snapshot's math is unit-tested directly, same as Round 1's
// portfolio-history.ts. The two returned totals always sum to the input's
// total value.
export function splitStocksAndCashEquivalent(
  holdings: ValuedHolding[]
): { stocksValue: number; cashEquivalentValue: number } {
  let stocksValue = 0;
  let cashEquivalentValue = 0;
  for (const h of holdings) {
    if (h.is_cash_equivalent) cashEquivalentValue += h.value;
    else stocksValue += h.value;
  }
  return { stocksValue, cashEquivalentValue };
}
