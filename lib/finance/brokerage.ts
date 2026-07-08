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

// The one holdings schema + validator both import paths funnel through lives
// in a pure module (unit-tested); re-exported here so callers importing the
// brokerage entry points get it too.
export { holdingSchema, validateHoldings, type ValidatedHoldings } from "@/lib/finance/holdings-schema";

export function looksLikeBrokerageCsv(content: string): boolean {
  return looksLikeBrokerageTable(parseCsv(content));
}

export function parseBrokerageCsv(content: string): BrokerageParseResult {
  return parseBrokerageTable(parseCsv(content));
}

// A positions statement (CSV or PDF) is a full snapshot of the whole account,
// so a newer one takes precedence: `replace` clears prior holdings first, so a
// position sold since the last statement disappears instead of lingering as a
// stale row that inflates net worth. (A `history` export is a partial activity
// log, not a snapshot, so it upserts.) Manual holdings entered by hand live
// under tickers a statement won't mention and are wiped by a full snapshot —
// acceptable for a single-portfolio setup; re-enter them or keep them off the
// statement account if you run more than one brokerage here.
export function importBrokerageHoldings(
  holdings: BrokerageHolding[],
  source: "positions" | "history",
  replace = source === "positions"
): BrokerageImportResult {
  const db = getDb();
  const apply = db.transaction(() => {
    if (replace) db.prepare("DELETE FROM holdings").run();
    const upsert = db.prepare(
      `INSERT INTO holdings (ticker, shares, cost_basis) VALUES (?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET shares = excluded.shares, cost_basis = excluded.cost_basis`
    );
    for (const h of holdings) upsert.run(h.ticker, h.shares, h.cost_basis);
  });
  apply();
  return { upserted: holdings.length, source };
}
