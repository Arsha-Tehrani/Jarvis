// Pure dividend math (no DB import) so node --test exercises it directly.

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// Payout for a dividend event = amount/share × shares held on the ex-date.
// When the ex-date share count isn't recorded we fall back to the CURRENT
// share count and flag the result approximate — never presenting an estimate
// as exact.
export function dividendPayout(
  amountPerShare: number,
  sharesAtDate: number | null,
  currentShares: number
): { payout: number; approximate: boolean } {
  if (sharesAtDate != null && sharesAtDate >= 0) {
    return { payout: round2(amountPerShare * sharesAtDate), approximate: false };
  }
  return { payout: round2(amountPerShare * currentShares), approximate: true };
}

// Running total + per-holding breakdown. `pending` rows (ex-date passed,
// cash not yet landed — see docs/dividend-automation.md) contribute ZERO to
// the total and the per-holding numbers until they're promoted to
// `confirmed` on the payment date; they're surfaced separately as
// pendingTotal. This is the one place getting it backwards would show a
// wrong number a user could act on.
export type DividendStatus = "pending" | "confirmed";

export function summarizeDividends(
  events: Array<{ ticker: string; payout: number; approximate: boolean; status: DividendStatus }>
): {
  total: number;
  pendingTotal: number;
  byHolding: Array<{ ticker: string; total: number; events: number; approximate: boolean }>;
} {
  const confirmed = events.filter((e) => e.status === "confirmed");
  const byTicker = new Map<string, { total: number; events: number; approximate: boolean }>();
  for (const e of confirmed) {
    const prev = byTicker.get(e.ticker) ?? { total: 0, events: 0, approximate: false };
    byTicker.set(e.ticker, {
      total: round2(prev.total + e.payout),
      events: prev.events + 1,
      approximate: prev.approximate || e.approximate,
    });
  }
  return {
    total: round2(confirmed.reduce((s, e) => s + e.payout, 0)),
    pendingTotal: round2(
      events.filter((e) => e.status === "pending").reduce((s, e) => s + e.payout, 0)
    ),
    byHolding: [...byTicker.entries()]
      .map(([ticker, v]) => ({ ticker, ...v }))
      .sort((a, b) => b.total - a.total),
  };
}
