// Pure filtering logic for the Finance page's four tabs (Phase 4). Built on
// top of Phase 2/3's account_type tagging — a tab is only as good as the
// classification feeding it, which is why this phase waited for those to land.

export type FinanceTab = "checking" | "credit_card" | "investment" | "total";

// Only the fields the tab filters actually need — callers pass their real
// transaction rows (which carry many more fields) and get them back typed.
export type TabbableTransaction = {
  account_type: string | null;
  category: string;
};

// Checking tab groups checking AND savings together (the user asked for one
// tab covering both, since they have statements of both types) — callers
// render a "Checking & Savings" subheading to make that grouping explicit
// rather than silent.
export function transactionsForTab<T extends TabbableTransaction>(
  txns: T[],
  tab: FinanceTab
): T[] {
  switch (tab) {
    case "checking":
      return txns.filter((t) => t.account_type === "checking" || t.account_type === "savings");
    case "credit_card":
      return txns.filter((t) => t.account_type === "credit_card");
    // Investment: transactions from investment-typed statements (shouldn't
    // normally occur -- brokerage imports are positions, not transactions --
    // but included for completeness) UNION the existing "Amount Invested"
    // ACH-transfer detection (category === "Investment"), so this tab
    // answers "what's going on with my investing" as one view.
    case "investment":
      return txns.filter((t) => t.account_type === "investment" || t.category === "Investment");
    // Total: the existing combined view, unchanged -- every transaction,
    // including untagged ones (never silently dropped from the whole-picture
    // view just because a statement's content didn't disambiguate its type).
    case "total":
      return txns;
  }
}

// Untagged transactions are a valid, non-error state (README already
// documents this) -- they still belong in Total, just called out with a
// count so nothing looks like it silently went missing.
export function unclassifiedCount<T extends TabbableTransaction>(txns: T[]): number {
  return txns.filter((t) => t.account_type == null).length;
}
