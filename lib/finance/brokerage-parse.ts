// Pure brokerage-CSV shape logic (no imports — unit-tested directly).
// Operates on a pre-parsed CSV table; lib/finance/brokerage.ts wraps it
// with the shared CSV parser and the DB upsert.

export type BrokerageHolding = { ticker: string; shares: number; cost_basis: number };

export type BrokerageParseResult = {
  holdings: BrokerageHolding[];
  source: "positions" | "history";
};

// Header sniff: does this table look like a brokerage export (vs a bank
// statement)? Positions have symbol+quantity; history has action+symbol.
export function looksLikeBrokerageTable(table: string[][]): boolean {
  const idx = findHeaderIndex(table);
  if (idx < 0) return false;
  const cols = table[idx].map((h) => h.trim().toLowerCase());
  const has = (name: string) => cols.some((c) => c.includes(name));
  return has("symbol") && (has("quantity") || has("shares") || has("action"));
}

// Fidelity CSVs often carry preamble lines and a disclaimer footer; find
// the real header row by looking for the Symbol column.
function findHeaderIndex(table: string[][]): number {
  for (let i = 0; i < Math.min(table.length, 10); i++) {
    const cols = table[i].map((h) => h.trim().toLowerCase());
    if (cols.some((c) => c === "symbol" || c.includes("symbol"))) return i;
  }
  return -1;
}

function findCol(header: string[], names: string[]): number {
  const cols = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const exact = cols.indexOf(name);
    if (exact >= 0) return exact;
  }
  for (const name of names) {
    const partial = cols.findIndex((c) => c.includes(name));
    if (partial >= 0) return partial;
  }
  return -1;
}

function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = raw.trim().replace(/[$,%\s]/g, "");
  if (!s || s === "--" || s === "n/a") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const value = Number(s);
  return negative ? -value : value;
}

// "AAPL", "SPAXX**" → "SPAXX"; skips pending/cash pseudo-rows.
function cleanTicker(raw: string): string | null {
  const ticker = raw.trim().toUpperCase().replace(/\*+$/, "");
  if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return null;
  if (ticker === "PENDING" || ticker === "CASH") return null;
  return ticker;
}

export function parseBrokerageTable(table: string[][]): BrokerageParseResult {
  const headerIdx = findHeaderIndex(table);
  if (headerIdx < 0) {
    throw new Error(
      "No Symbol column found — export the Positions view (or Accounts history) from Fidelity as CSV."
    );
  }
  const header = table[headerIdx];
  const rows = table.slice(headerIdx + 1);
  const isHistory = findCol(header, ["action"]) >= 0;

  return isHistory
    ? { holdings: parseHistory(header, rows), source: "history" }
    : { holdings: parsePositions(header, rows), source: "positions" };
}

function parsePositions(header: string[], rows: string[][]): BrokerageHolding[] {
  const symbolCol = findCol(header, ["symbol"]);
  const qtyCol = findCol(header, ["quantity", "shares"]);
  const avgCostCol = findCol(header, ["average cost basis", "avg cost", "cost basis per share"]);
  const totalCostCol = findCol(header, ["cost basis total", "cost basis", "total cost"]);
  if (symbolCol < 0 || qtyCol < 0) {
    throw new Error(
      `Positions CSV needs Symbol and Quantity columns (saw: ${header.map((h) => h.trim()).filter(Boolean).join(", ")}).`
    );
  }

  const holdings: BrokerageHolding[] = [];
  for (const cells of rows) {
    const ticker = cleanTicker(cells[symbolCol] ?? "");
    if (!ticker) continue;
    const shares = parseNumber(cells[qtyCol]);
    if (shares == null || shares <= 0) continue;
    let costBasis = avgCostCol >= 0 ? parseNumber(cells[avgCostCol]) : null;
    if (costBasis == null && totalCostCol >= 0) {
      const total = parseNumber(cells[totalCostCol]);
      if (total != null) costBasis = total / shares;
    }
    holdings.push({ ticker, shares, cost_basis: round2(costBasis ?? 0) });
  }
  if (holdings.length === 0) {
    throw new Error("No position rows recognized — export the Positions view as CSV.");
  }
  return dedupe(holdings);
}

function parseHistory(header: string[], rows: string[][]): BrokerageHolding[] {
  const symbolCol = findCol(header, ["symbol"]);
  const actionCol = findCol(header, ["action"]);
  const qtyCol = findCol(header, ["quantity"]);
  const priceCol = findCol(header, ["price"]);
  if (symbolCol < 0 || actionCol < 0 || qtyCol < 0) {
    throw new Error(
      `History CSV needs Action, Symbol and Quantity columns (saw: ${header.map((h) => h.trim()).filter(Boolean).join(", ")}).`
    );
  }

  type Acc = { shares: number; buyShares: number; buyCost: number };
  const bySymbol = new Map<string, Acc>();
  for (const cells of rows) {
    const action = (cells[actionCol] ?? "").toUpperCase();
    if (!/BOUGHT|SOLD|REINVEST/.test(action)) continue;
    const ticker = cleanTicker(cells[symbolCol] ?? "");
    if (!ticker) continue;
    const qty = parseNumber(cells[qtyCol]);
    if (qty == null || qty === 0) continue;
    const price = priceCol >= 0 ? (parseNumber(cells[priceCol]) ?? 0) : 0;

    const acc = bySymbol.get(ticker) ?? { shares: 0, buyShares: 0, buyCost: 0 };
    // Buys positive, sells negative (use the action word when the sign
    // is missing from the quantity column).
    const signed = /SOLD/.test(action) ? -Math.abs(qty) : Math.abs(qty);
    acc.shares += signed;
    if (signed > 0) {
      acc.buyShares += signed;
      acc.buyCost += signed * price;
    }
    bySymbol.set(ticker, acc);
  }

  const holdings: BrokerageHolding[] = [];
  for (const [ticker, acc] of bySymbol) {
    if (acc.shares <= 0.0001) continue; // fully sold
    holdings.push({
      ticker,
      shares: round4(acc.shares),
      cost_basis: round2(acc.buyShares > 0 ? acc.buyCost / acc.buyShares : 0),
    });
  }
  if (holdings.length === 0) {
    throw new Error(
      "No open positions could be reconstructed from the history CSV — export the Positions view instead."
    );
  }
  return holdings;
}

function dedupe(holdings: BrokerageHolding[]): BrokerageHolding[] {
  // Same ticker across accounts: merge shares, weight the cost basis.
  const merged = new Map<string, BrokerageHolding>();
  for (const h of holdings) {
    const prev = merged.get(h.ticker);
    if (!prev) {
      merged.set(h.ticker, { ...h });
    } else {
      const shares = prev.shares + h.shares;
      merged.set(h.ticker, {
        ticker: h.ticker,
        shares,
        cost_basis: round2(
          (prev.cost_basis * prev.shares + h.cost_basis * h.shares) / shares
        ),
      });
    }
  }
  return [...merged.values()];
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
