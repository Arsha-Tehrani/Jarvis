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

// Sub-type within "transaction" — which account this statement is FOR. Never
// derived from the filename, only from content, same as `kind` above. A
// bank/card statement with no distinguishing signal (a generic Date/
// Description/Amount CSV with no balance column or card-specific wording)
// is left undetermined rather than guessed — it still imports, just without
// an account badge, per classifyStatementText/Table's callers.
export type AccountSubKind = "checking" | "savings" | "credit_card";

export type Classification = {
  kind: StatementKind;
  // Only meaningful when kind === "transaction". `subKindConflict: true` means
  // BOTH credit-card and checking/savings signals fired — a statement can't
  // honestly be both, so the caller rejects rather than picking one.
  subKind?: AccountSubKind;
  subKindConflict?: boolean;
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

// Sub-type signals within "transaction" — same content-based approach as the
// kind classification above. Savings is checked before the generic balance
// structure because a savings statement has the SAME running-balance layout
// as checking; only the account-name wording tells them apart.
const CREDIT_CARD_SIGNAL =
  /Minimum Payment Due|New Balance:?\s*\$|Credit Limit|Available Credit|Payment Due Date/i;
const SAVINGS_SIGNAL = /Savings Account|Regular Savings|Statement Savings|Total Savings/i;
const CHECKING_STRUCTURE_SIGNAL =
  /DATE\s+DESCRIPTION\s+AMOUNT\s+BALANCE|Beginning Balance\s*\$?[\d,]+\.\d{2}|Ending Balance\s*\$?[\d,]+\.\d{2}|Total Checking|Checking Account/i;

// Returns undefined subKind (not a conflict) when the content gives no
// distinguishing signal at all — e.g. a generic Date/Description/Amount CSV
// with no balance column or card-specific wording. That's left unlabeled
// rather than rejected: it's a real, importable statement, just one we can't
// confidently badge as a specific account type.
function detectSubKind(text: string): Pick<Classification, "subKind" | "subKindConflict"> & {
  subKindSignal?: string;
} {
  const isCard = CREDIT_CARD_SIGNAL.test(text);
  const isSavings = SAVINGS_SIGNAL.test(text);
  const hasCheckingStructure = CHECKING_STRUCTURE_SIGNAL.test(text);
  if (isCard && (isSavings || hasCheckingStructure)) {
    return { subKindConflict: true };
  }
  if (isCard) return { subKind: "credit_card", subKindSignal: "credit-card wording (Minimum Payment Due / New Balance)" };
  if (isSavings) return { subKind: "savings", subKindSignal: "savings account wording" };
  if (hasCheckingStructure) return { subKind: "checking", subKindSignal: "checking-style running balance structure" };
  return {};
}

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
    const { subKind, subKindConflict, subKindSignal } = detectSubKind(text);
    if (subKindSignal) signals.push(subKindSignal);
    if (subKindConflict) signals.push("both credit-card and checking/savings signals present");
    return {
      kind: "transaction",
      subKind,
      subKindConflict,
      confidence: txnHeader ? 0.85 : 0.6,
      signals,
    };
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
    // Flatten the whole table (header + cells) through the same prose signals
    // used for PDFs — a CSV export can carry "Minimum Payment Due" or
    // "Savings Account" in a summary row or column value. A bare "Balance"
    // column (no prose match) is still a checking/savings signal on its own,
    // since running-balance columns are how bank exports look structurally
    // different from card exports.
    const flattened = table.map((row) => row.join(" ")).join("\n");
    const sub = detectSubKind(flattened);
    let { subKind, subKindConflict } = sub;
    const hasBalanceCol = has(["balance"]);
    if (!subKind && !subKindConflict && hasBalanceCol) {
      subKind = "checking";
    } else if (subKind === "credit_card" && hasBalanceCol) {
      subKind = undefined;
      subKindConflict = true;
    }
    const signals = ["CSV has date, description and amount columns"];
    if (sub.subKindSignal) signals.push(sub.subKindSignal);
    else if (subKind === "checking") signals.push("CSV has a running-balance column");
    if (subKindConflict) signals.push("both credit-card and checking/savings signals present");
    return { kind: "transaction", subKind, subKindConflict, confidence: 0.9, signals };
  }
  return {
    kind: "unknown",
    confidence: 0,
    signals: [`CSV columns not recognized: [${header.join(", ")}]`],
  };
}
