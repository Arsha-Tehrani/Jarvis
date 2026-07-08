// Pure holdings-validation module (no DB import) so `node --test` can exercise
// the gate directly. One schema stands between BOTH brokerage import paths —
// the CSV shape-detector and the PDF table extractor — and the holdings table,
// so neither can slip a malformed row (blank ticker, non-positive shares) in.
import { z } from "zod";
import type { BrokerageHolding } from "./brokerage-parse.ts";

export const holdingSchema = z.object({
  ticker: z.string().regex(/^[A-Z][A-Z0-9.\-]{0,9}$/, "ticker must be an uppercase symbol"),
  shares: z.number().positive("shares must be > 0"),
  cost_basis: z.number().min(0, "cost basis cannot be negative"),
});

export type ValidatedHoldings = {
  holdings: BrokerageHolding[];
  warnings: string[];
};

// Rows that fail hard (bad ticker, non-positive shares) are dropped with a
// named warning rather than aborting the whole import; a $0 cost basis is a
// soft warning (Fidelity omits cost basis on core/cash positions) — the row
// is kept so the position still counts toward market value.
export function validateHoldings(holdings: BrokerageHolding[]): ValidatedHoldings {
  const valid: BrokerageHolding[] = [];
  const warnings: string[] = [];
  for (const h of holdings) {
    const parsed = holdingSchema.safeParse(h);
    if (!parsed.success) {
      warnings.push(`dropped ${h.ticker || "(blank)"}: ${z.prettifyError(parsed.error)}`);
      continue;
    }
    if (parsed.data.cost_basis === 0) {
      warnings.push(`${parsed.data.ticker}: no cost basis in statement (kept, gain/loss will read as 0)`);
    }
    valid.push(parsed.data);
  }
  return { holdings: valid, warnings };
}
