import { getDb } from "@/lib/db";
import {
  looksLikeBrokerageTable,
  parseBrokerageTable,
  type BrokerageHolding,
  type BrokerageParseResult,
} from "@/lib/finance/brokerage-parse";
import { parseCsv } from "@/lib/finance/parse";

// Fidelity has no free personal API, so holdings come in by CSV the same
// way bank statements do (drop in /statements, hit Import). Shape logic
// lives in brokerage-parse.ts (pure, unit-tested); this file wires the
// shared CSV parser and the holdings upsert. Account-number columns are
// never persisted. Re-imports upsert by ticker — never delete, so a second
// account's export or manual holdings can't be clobbered.

export type { BrokerageHolding };

export type BrokerageImportResult = {
  upserted: number;
  source: "positions" | "history";
};

export function looksLikeBrokerageCsv(content: string): boolean {
  return looksLikeBrokerageTable(parseCsv(content));
}

export function parseBrokerageCsv(content: string): BrokerageParseResult {
  return parseBrokerageTable(parseCsv(content));
}

export function importBrokerageHoldings(
  holdings: BrokerageHolding[],
  source: "positions" | "history"
): BrokerageImportResult {
  const db = getDb();
  const apply = db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO holdings (ticker, shares, cost_basis) VALUES (?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET shares = excluded.shares, cost_basis = excluded.cost_basis`
    );
    for (const h of holdings) upsert.run(h.ticker, h.shares, h.cost_basis);
  });
  apply();
  return { upserted: holdings.length, source };
}
