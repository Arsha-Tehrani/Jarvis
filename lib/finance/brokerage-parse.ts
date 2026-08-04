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

// ---- Fidelity brokerage/investment PDF holdings ----
//
// Fidelity statements list each holding as:
//   <NAME> (<SYMBOL>) <begin> <qty> <price> <mkt value> <cost> <unrealized> <eai|->
// e.g.  MICROSOFT CORP (MSFT) 450.24 2.000 373.0200 746.04 770.47 -24.43 7.28
// The leading columns vary, so instead of trusting positions we locate the
// qty/price/value/cost run by arithmetic: qty*price must equal the market
// value and value-cost must equal the unrealized gain. That self-check makes
// false matches (disclaimer text, transaction lines) essentially impossible.
//
// Long security names wrap: for many rows the "(SYMBOL)" ends one line and the
// numeric columns land on the NEXT line (or two). Missing those wraps is why
// an earlier build captured only a third of the account and net worth read
// far too low — so a holding record starts at the ticker and absorbs the
// following wrap line(s) until it has enough numbers to resolve.
//
// The core money-market position (SPAXX) prints "not applicable" where cost /
// unrealized would be; its cost basis is taken as its price ($1.00) so its
// market value (≈ its cash balance) is right and it shows no phantom gain.

// Ticker in parentheses, anywhere on the line.
const TICKER_IN_LINE = /\(([A-Z][A-Z0-9.\-]{0,9})\)/;
// Lines that must not be pulled into a holding's number run.
const HOLDING_BOUNDARY = /^(total\b|subtotal|core account|estimated|page \d|beginning|ending)/i;
// Non-priced/pseudo tickers that aren't real positions.
const HOLDING_SKIP = new Set(["AI", "CASH", "PENDING"]);

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.002);
}

// Numeric columns as Fidelity prints them: optional leading "-", optional "$"
// (which can sit between the minus and the digits, e.g. "-$105.09"), and
// accounting-style "(…)" negatives. Sign is taken from the "-" or the parens.
function numberTokens(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(-)?\$?(\()?(\d[\d,]*\.\d+)(\))?/g)) {
    let v = Number(m[3].replace(/,/g, ""));
    if (m[1] === "-" || (m[2] === "(" && m[4] === ")")) v = -v;
    out.push(v);
  }
  return out;
}

// Resolve a holding from the numeric columns following a ticker. Prefers the
// full six-column match (qty*price==value AND value-cost==unrealized), which
// unambiguously skips the leading "begin value" column. Falls back to the
// three-column match (qty*price==value) only when the cost/unrealized columns
// are "not applicable" — i.e. a money-market/core position.
function resolveHolding(
  ticker: string,
  buffer: string,
  costNotApplicable: boolean
): BrokerageHolding | null {
  const nums = numberTokens(buffer);

  // Full match first.
  for (let i = 0; i + 4 < nums.length; i++) {
    const [qty, price, value, cost, unreal] = [nums[i], nums[i + 1], nums[i + 2], nums[i + 3], nums[i + 4]];
    if (qty <= 0 || price <= 0 || value <= 0 || cost < 0) continue;
    if (!approx(qty * price, value)) continue;
    if (!approx(value - cost, unreal)) continue;
    return { ticker, shares: round4(qty), cost_basis: round2(cost / qty) };
  }

  // Money-market / "not applicable" cost: only qty, price, value are present.
  if (costNotApplicable) {
    for (let i = 0; i + 2 < nums.length; i++) {
      const [qty, price, value] = [nums[i], nums[i + 1], nums[i + 2]];
      if (qty <= 0 || price <= 0 || value <= 0) continue;
      if (!approx(qty * price, value)) continue;
      return { ticker, shares: round4(qty), cost_basis: round2(price) };
    }
  }
  return null;
}

export function parseFidelityPdfHoldings(text: string): BrokerageHolding[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const holdings: BrokerageHolding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TICKER_IN_LINE.exec(lines[i]);
    if (!m) continue;
    const ticker = cleanTicker(m[1]);
    if (!ticker || HOLDING_SKIP.has(ticker)) continue;

    // Numbers after the ticker on this line, plus up to two following wrap
    // lines (stop at the next ticker or a section boundary).
    let buffer = lines[i].slice(m.index + m[0].length);
    let notApplicable = /not applicable|n\/a/i.test(buffer);
    for (let j = i + 1; numberTokens(buffer).length < 5 && j < lines.length && j <= i + 2; j++) {
      const next = lines[j];
      if (!next || TICKER_IN_LINE.test(next) || HOLDING_BOUNDARY.test(next)) break;
      buffer += " " + next;
      if (/not applicable|n\/a/i.test(next)) notApplicable = true;
    }

    const h = resolveHolding(ticker, buffer, notApplicable);
    if (h) holdings.push(h);
  }
  return dedupe(holdings);
}
