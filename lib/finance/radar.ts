import { getDb } from "@/lib/db";

// Recurring-bill radar, built on the Phase 3 recurring detection.
// Deterministic (dates + amounts only, no LLM): estimates each
// subscription's next renewal from its median gap, flags "renews in ~N
// days" (≤14) and "amount jumped >10% vs the usual" (latest vs the median
// of the earlier charges).

export type RadarItem = {
  merchant: string;
  lastAmount: number;
  usualAmount: number;
  lastDate: string;
  medianGapDays: number;
  nextRenewal: string; // YYYY-MM-DD estimate
  daysUntil: number; // negative = estimate already passed
  renewsSoon: boolean;
  jumpPercent: number | null; // set when latest > usual by >10%
};

type Row = { merchant: string; amount: number; date: string };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Pure core — takes recurring rows (amount < 0, sign-flipped by caller no;
// keep raw negatives and flip here) grouped by merchant upstream of the DB.
export function computeRadar(rows: Row[], today = new Date()): RadarItem[] {
  const byMerchant = new Map<string, Row[]>();
  for (const row of rows) {
    const group = byMerchant.get(row.merchant) ?? [];
    group.push(row);
    byMerchant.set(row.merchant, group);
  }

  const todayMs = Date.parse(today.toISOString().slice(0, 10));
  const items: RadarItem[] = [];
  for (const [merchant, group] of byMerchant) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    const amounts = sorted.map((r) => Math.abs(r.amount));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(
        Math.round((Date.parse(sorted[i].date) - Date.parse(sorted[i - 1].date)) / 86400_000)
      );
    }
    const medianGapDays = Math.round(median(gaps));
    const lastDate = sorted[sorted.length - 1].date;
    const nextMs = Date.parse(lastDate) + medianGapDays * 86400_000;
    const nextRenewal = new Date(nextMs).toISOString().slice(0, 10);
    const daysUntil = Math.round((nextMs - todayMs) / 86400_000);

    const lastAmount = amounts[amounts.length - 1];
    const usualAmount =
      amounts.length > 1 ? median(amounts.slice(0, -1)) : lastAmount;
    const jump = usualAmount > 0 ? ((lastAmount - usualAmount) / usualAmount) * 100 : 0;

    items.push({
      merchant,
      lastAmount,
      usualAmount,
      lastDate,
      medianGapDays,
      nextRenewal,
      daysUntil,
      renewsSoon: daysUntil >= -3 && daysUntil <= 14,
      jumpPercent: jump > 10 ? Math.round(jump) : null,
    });
  }
  return items.sort((a, b) => a.daysUntil - b.daysUntil);
}

export function billRadar(): RadarItem[] {
  const rows = getDb()
    .prepare(
      "SELECT merchant, amount, date FROM transactions WHERE is_recurring = 1 AND amount < 0"
    )
    .all() as Row[];
  return computeRadar(rows);
}
