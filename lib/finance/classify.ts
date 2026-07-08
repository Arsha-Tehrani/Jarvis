// Single content-based statement classifier. Both CSV tables and PDF text
// feed the same classifier and converge on one typed verdict, so we never
// route a file by its extension alone. A Fidelity statement dropped as a PDF
// and the same data exported as CSV must land on the same `kind`.
//
// This is the decision point Part A adds in front of parsing: get the type
// wrong and a brokerage report gets mis-read as spending (poisoning both the
// finance totals and net worth), so classification is deliberately structural
// — it probes for the actual shapes (arithmetically-consistent holding rows,
// dated running-balance transaction rows), not just letterhead keywords.

// Relative imports (not the "@/" alias) so this stays loadable by the pure
// `node --test` runner, like the other unit-tested finance modules it builds on.
import { groupRecords } from "./parse.ts";
import { parseFidelityPdfHoldings, looksLikeBrokerageTable } from "./brokerage-parse.ts";

export type StatementKind = "brokerage" | "transaction" | "unknown";

export type Classification = {
  kind: StatementKind;
  // 0..1 — how sure we are. Below CONFIDENCE_FLOOR the caller rejects the
  // file with a visible reason instead of importing possibly-wrong numbers.
  confidence: number;
  // Human-readable reasons, surfaced in the import result for debugging.
  signals: string[];
};

// A file classified below this is rejected rather than guessed-and-imported.
export const CONFIDENCE_FLOOR = 0.5;

const BROKERAGE_HEADER =
  /INVESTMENT REPORT|Brokerage services provided|Your Account Value|Ending Account Value|Holdings?\s+as of|Positions?\s+as of|Realized Gain\/Loss|Symbol\/?\s*CUSIP/i;
const TXN_HEADER =
  /DATE\s+DESCRIPTION\s+AMOUNT\s+BALANCE|Minimum Payment Due|Beginning Balance\s*\$?[\d,]+\.\d{2}|Payment Due Date/i;

// A grouped record that carries a decimal amount and an actual payee name
// (≥2 letters) — the shape of a real dated transaction line.
function countTransactionRecords(text: string): number {
  const records = groupRecords(text.split(/\r?\n/));
  let n = 0;
  for (const rec of records) {
    const hasDecimal = /-?\$?\(?\d[\d,]*\.\d{2}\)?/.test(rec.text);
    const hasName = (rec.text.replace(/^\d{1,2}\/\d{1,2}/, "").match(/[A-Za-z]/g) ?? []).length >= 2;
    if (hasDecimal && hasName) n++;
  }
  return n;
}

// Classify already-extracted PDF (or any flat) text.
export function classifyStatementText(text: string): Classification {
  const brokerageHeader = BROKERAGE_HEADER.test(text);
  const txnHeader = TXN_HEADER.test(text);
  // Strongest signal available: how many holding rows survive the arithmetic
  // self-check (qty×price ≈ market value). Prose/disclaimer lines can't.
  const holdingRows = parseFidelityPdfHoldings(text).length;
  const txnRows = countTransactionRecords(text);

  const signals: string[] = [];
  if (brokerageHeader) signals.push("brokerage letterhead/columns present");
  if (holdingRows > 0) signals.push(`${holdingRows} consistent holding row(s)`);
  if (txnHeader) signals.push("transaction/statement header present");
  if (txnRows > 0) signals.push(`${txnRows} dated transaction row(s)`);

  // Holdings that pass the arithmetic check are near-impossible to forge, so
  // they dominate. A statement can carry both (a brokerage report may list
  // activity), so compare magnitudes rather than treating either as binary.
  if (holdingRows >= 2 && holdingRows >= txnRows) {
    return { kind: "brokerage", confidence: 0.95, signals };
  }
  if (brokerageHeader && holdingRows >= 1 && !txnHeader) {
    return { kind: "brokerage", confidence: 0.8, signals };
  }
  if (txnHeader || txnRows >= 3) {
    // A brokerage report with no extractable holdings but transaction-shaped
    // lines is still safer treated as a transaction statement only when it
    // lacks brokerage letterhead; otherwise it's an unparseable brokerage doc.
    if (brokerageHeader && holdingRows === 0 && txnRows < 3) {
      signals.push("looks like a brokerage report but no holdings could be extracted");
      return { kind: "brokerage", confidence: 0.3, signals };
    }
    return { kind: "transaction", confidence: txnHeader ? 0.85 : 0.6, signals };
  }
  if (brokerageHeader) {
    signals.push("brokerage letterhead but no holdings extracted");
    return { kind: "brokerage", confidence: 0.3, signals };
  }
  signals.push("no recognizable holdings or transaction structure");
  return { kind: "unknown", confidence: 0, signals };
}

// Classify a pre-parsed CSV table. Reuses the brokerage header sniff and the
// bank-CSV column requirements so CSV and PDF converge on the same verdict.
export function classifyStatementTable(table: string[][]): Classification {
  if (table.length < 1) {
    return { kind: "unknown", confidence: 0, signals: ["empty file"] };
  }
  if (looksLikeBrokerageTable(table)) {
    return {
      kind: "brokerage",
      confidence: 0.9,
      signals: ["CSV has Symbol + Quantity/Shares/Action columns"],
    };
  }
  // Bank/credit-card CSV needs date + description + an amount (or debit/credit).
  const header = table[0].map((h) => h.trim().toLowerCase());
  const has = (names: string[]) =>
    names.some((n) => header.some((h) => h.includes(n)));
  const hasDate = has(["date"]);
  const hasDesc = has(["description", "merchant", "payee", "name", "details", "memo"]);
  const hasAmount = has(["amount", "debit", "credit", "withdrawal", "deposit", "money out", "money in"]);
  if (hasDate && hasDesc && hasAmount) {
    return {
      kind: "transaction",
      confidence: 0.9,
      signals: ["CSV has date, description and amount columns"],
    };
  }
  return {
    kind: "unknown",
    confidence: 0,
    signals: [`CSV columns not recognized: [${header.join(", ")}]`],
  };
}
