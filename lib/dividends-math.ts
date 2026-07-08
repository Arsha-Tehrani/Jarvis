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
