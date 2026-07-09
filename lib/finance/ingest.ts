import fs from "fs";
import path from "path";
import { getDb } from "@/lib/db";
import {
  importBrokerageHoldings,
  parseBrokerageCsv,
  validateHoldings,
} from "@/lib/finance/brokerage";
import { parseFidelityPdfHoldings } from "@/lib/finance/brokerage-parse";
import { categorizeTransactions } from "@/lib/finance/categorize";
import {
  classifyStatementTable,
  classifyStatementText,
  CONFIDENCE_FLOOR,
  type AccountSubKind,
  type Classification,
} from "@/lib/finance/classify";
import { findTransferPairs, type TransferCandidate } from "@/lib/finance/transfers";
import {
  extractPdfText,
  extractStatementBalance,
  inferPeriodEnd,
  parseCsv,
  parseCsvStatement,
  parsePdfText,
  redactAccountNumbers,
  type ParsedTransaction,
} from "@/lib/finance/parse";

// Import flow: scan /statements for files not yet in the statements table,
// classify (content-based, extension-independent), parse (redacting account
// numbers), store, categorize, re-detect recurring charges. Everything stays
// on this machine.
//
// The classifier is the front door: a file is routed by what it actually
// contains, and a file we can't confidently parse is REJECTED with a visible
// reason rather than imported with wrong/zeroed numbers — a confident wrong
// number is worse than a clear "couldn't parse this".

export type ImportStatus = "imported" | "warning" | "rejected";

export type ImportResult = {
  file: string;
  status: ImportStatus;
  imported: number;
  kind: "transaction" | "brokerage" | "unknown";
  accountType?: AccountSubKind;
  categorizedBy?: string;
  warnings?: string[];
  reason?: string; // set when status === "rejected"
  llmError?: string;
  confidence?: number;
  signals?: string[];
};

export function statementsDir(): string {
  const dir = path.join(process.cwd(), "statements");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return dir;
}

export async function importNewStatements(): Promise<ImportResult[]> {
  const dir = statementsDir();
  const db = getDb();
  const known = new Set(
    (db.prepare("SELECT file_path FROM statements").all() as { file_path: string }[]).map(
      (r) => r.file_path
    )
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(csv|pdf)$/i.test(f))
    .filter((f) => !known.has(f));

  const results: ImportResult[] = [];
  for (const file of files) {
    try {
      results.push(await importOne(dir, file));
    } catch (err) {
      results.push({
        file,
        status: "rejected",
        imported: 0,
        kind: "unknown",
        reason: err instanceof Error ? err.message : "import failed",
      });
    }
  }
  if (results.some((r) => r.imported > 0)) {
    detectRecurring();
    detectTransfers();
  }
  return results;
}

// Record a file in the statements table (so the scan doesn't retry it) with
// the classified kind and a redacted excerpt of what we actually parsed.
function recordStatement(
  file: string,
  month: string,
  kind: string,
  rawText: string,
  accountType?: AccountSubKind
): number {
  const excerpt = redactAccountNumbers(rawText).slice(0, 8000);
  const info = getDb()
    .prepare(
      "INSERT INTO statements (month, file_path, kind, raw_text, account_type) VALUES (?, ?, ?, ?, ?)"
    )
    .run(month, file, kind, excerpt, accountType ?? null);
  return info.lastInsertRowid as number;
}

function rejected(
  file: string,
  kind: Classification["kind"],
  reason: string,
  classification?: Classification
): ImportResult {
  return {
    file,
    status: "rejected",
    imported: 0,
    kind,
    reason,
    confidence: classification?.confidence,
    signals: classification?.signals,
  };
}

async function importOne(dir: string, file: string): Promise<ImportResult> {
  const fullPath = path.join(dir, file);
  const isPdf = /\.pdf$/i.test(file);

  // Extract once into a form the classifier and the parsers both consume:
  // PDF → flat text, CSV → a parsed table (kept as text too, for the classifier
  // signals and the debug excerpt).
  const rawText = isPdf
    ? await extractPdfText(fs.readFileSync(fullPath))
    : fs.readFileSync(fullPath, "utf8");
  const table = isPdf ? null : parseCsv(rawText);

  const classification = isPdf
    ? classifyStatementText(rawText)
    : classifyStatementTable(table!);

  if (classification.kind === "unknown" || classification.confidence < CONFIDENCE_FLOOR) {
    return rejected(
      file,
      classification.kind,
      classification.kind === "unknown"
        ? `Couldn't recognize this as a bank statement or a brokerage statement (${classification.signals.join("; ")}).`
        : `Low confidence (${Math.round(classification.confidence * 100)}%) that this is a ${classification.kind} statement — not importing to avoid wrong numbers (${classification.signals.join("; ")}).`,
      classification
    );
  }

  // A statement can't honestly be both a credit card and a checking/savings
  // account — this is the conflict classify.ts flags rather than guessing,
  // e.g. a PDF with both "Minimum Payment Due" and "Beginning Balance" text.
  if (classification.kind === "transaction" && classification.subKindConflict) {
    return rejected(
      file,
      "transaction",
      `Content matches both credit-card and checking/savings statement patterns — can't tell which account this is for (${classification.signals.join("; ")}). Not importing to avoid mislabeling or double-counting a transfer.`,
      classification
    );
  }

  return classification.kind === "brokerage"
    ? importBrokerage(file, rawText, table, classification)
    : importTransactions(file, rawText, table, classification);
}

// Brokerage (CSV positions/history OR PDF holdings) → validated holdings
// upserts. Both paths funnel through validateHoldings + the shared schema.
function importBrokerage(
  file: string,
  rawText: string,
  table: string[][] | null,
  classification: Classification
): ImportResult {
  let extracted;
  let source: string;
  try {
    if (table) {
      const parsed = parseBrokerageCsv(rawText);
      extracted = parsed.holdings;
      source = `brokerage ${parsed.source}`;
    } else {
      extracted = parseFidelityPdfHoldings(rawText);
      source = "brokerage positions (PDF)";
    }
  } catch (err) {
    return rejected(
      file,
      "brokerage",
      err instanceof Error ? err.message : "could not parse brokerage file",
      classification
    );
  }

  const { holdings, warnings } = validateHoldings(extracted);
  if (holdings.length === 0) {
    return rejected(
      file,
      "brokerage",
      "Recognized as a brokerage statement, but no holdings rows could be extracted — the expected columns (Symbol/Quantity/Market Value) didn't line up. Try exporting the Positions view as CSV.",
      classification
    );
  }

  const { year, month } = inferPeriodEnd(rawText);
  const statementMonth = `${year}-${String(month).padStart(2, "0")}`;
  recordStatement(file, statementMonth, "brokerage", rawText);
  const result = importBrokerageHoldings(holdings, source.includes("history") ? "history" : "positions");
  return {
    file,
    status: warnings.length > 0 ? "warning" : "imported",
    imported: result.upserted,
    kind: "brokerage",
    categorizedBy: source,
    warnings: warnings.length > 0 ? warnings : undefined,
    confidence: classification.confidence,
    signals: classification.signals,
  };
}

async function importTransactions(
  file: string,
  rawText: string,
  table: string[][] | null,
  classification: Classification
): Promise<ImportResult> {
  let rows: ParsedTransaction[];
  try {
    rows = table ? parseCsvStatement(rawText) : parsePdfText(rawText);
  } catch (err) {
    return rejected(
      file,
      "transaction",
      err instanceof Error ? err.message : "could not parse transactions",
      classification
    );
  }
  if (rows.length === 0) {
    return rejected(file, "transaction", "No transactions found in file", classification);
  }

  const db = getDb();
  // Statement month = most common YYYY-MM among rows.
  const monthCounts = new Map<string, number>();
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
  }
  const month = [...monthCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // Summary balance (ending/new balance) for the net-worth suggestion — stored,
  // never auto-applied to an account.
  const balance = extractStatementBalance(rawText);

  const insertedIds: number[] = [];
  let statementId = -1;
  const insertAll = db.transaction(() => {
    statementId = recordStatement(file, month, "transaction", rawText, classification.subKind);
    if (balance) {
      db.prepare(
        "UPDATE statements SET ending_balance = ?, balance_kind = ?, balance_label = ? WHERE id = ?"
      ).run(balance.balance, balance.kind, balance.label, statementId);
    }
    const insert = db.prepare(
      `INSERT INTO transactions (date, amount, merchant, category, raw_description, statement_id, account_type)
       VALUES (?, ?, ?, 'Uncategorized', ?, ?, ?)`
    );
    for (const r of rows) {
      const rowInfo = insert.run(
        r.date,
        r.amount,
        r.merchant,
        r.raw_description,
        statementId,
        classification.subKind ?? null
      );
      insertedIds.push(rowInfo.lastInsertRowid as number);
    }
  });
  insertAll();

  // Categorize after commit: rows are safe either way, categories are an
  // update. LLM unavailable → keyword rules, ingest still succeeds.
  const lines = insertedIds.map((id, i) => ({
    id,
    description: rows[i].raw_description,
    amount: rows[i].amount,
  }));
  const outcome = await categorizeTransactions(lines);
  const update = db.prepare("UPDATE transactions SET category = ? WHERE id = ?");
  const applyCategories = db.transaction(() => {
    for (const [id, category] of outcome.categories) update.run(category, id);
  });
  applyCategories();

  // User corrections win over everything: a merchant the user previously
  // re-categorized keeps that category on this and future imports.
  db.prepare(
    `UPDATE transactions SET category = (
       SELECT category FROM category_overrides o WHERE o.merchant = transactions.merchant
     )
     WHERE statement_id = ?
       AND merchant IN (SELECT merchant FROM category_overrides)`
  ).run(statementId);

  return {
    file,
    status: outcome.llmError ? "warning" : "imported",
    imported: rows.length,
    kind: "transaction",
    accountType: classification.subKind,
    categorizedBy: outcome.source,
    llmError: outcome.llmError,
    warnings: outcome.llmError
      ? [`LLM unavailable (${outcome.llmError}); keyword rules used`]
      : undefined,
    confidence: classification.confidence,
    signals: classification.signals,
  };
}

// A real-world payment (e.g. paying a credit card bill) posts as an outflow
// on one account and an inflow on another — two rows for one dollar amount
// moving, not spend and not income. Runs over ALL transactions (like
// detectRecurring below), not just newly-imported ones, so a checking
// statement imported today still matches a card statement imported weeks
// ago. Forces category='Transfer' on matched pairs — the same category
// lib/finance/analyze.ts's NON_SPEND already excludes from spend/income.
export function detectTransfers(): void {
  const db = getDb();
  // Not filtered by category: a row a keyword rule already caught as
  // 'Transfer' must still be a candidate, or its actual pair (which the
  // keyword rules may have missed — bank wording varies) never finds it.
  const rows = db
    .prepare(
      `SELECT id, date, amount, raw_description, statement_id FROM transactions
       WHERE statement_id IS NOT NULL`
    )
    .all() as TransferCandidate[];

  const matchedIds = findTransferPairs(rows);
  if (matchedIds.length === 0) return;

  const mark = db.prepare("UPDATE transactions SET category = 'Transfer' WHERE id = ?");
  const apply = db.transaction(() => {
    for (const id of matchedIds) mark.run(id);
  });
  apply();
}

// Same merchant + similar amount + roughly monthly cadence → subscription.
export function detectRecurring(): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, merchant, amount, date FROM transactions
       WHERE amount < 0 ORDER BY merchant, date`
    )
    .all() as { id: number; merchant: string; amount: number; date: string }[];

  const byMerchant = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byMerchant.get(row.merchant) ?? [];
    group.push(row);
    byMerchant.set(row.merchant, group);
  }

  const recurringIds: number[] = [];
  for (const group of byMerchant.values()) {
    if (group.length < 2) continue;
    const amounts = group.map((g) => Math.abs(g.amount));
    const maxAmt = Math.max(...amounts);
    const minAmt = Math.min(...amounts);
    // 25% band (was 15%): a subscription that raised its price is still
    // the same subscription — the bill radar flags the jump separately.
    const similarAmounts = maxAmt - minAmt <= Math.max(2, maxAmt * 0.25);
    if (!similarAmounts) continue;
    const gaps: number[] = [];
    for (let i = 1; i < group.length; i++) {
      gaps.push(
        (Date.parse(group[i].date) - Date.parse(group[i - 1].date)) / 86400_000
      );
    }
    const monthly = gaps.every((g) => g >= 21 && g <= 38);
    if (monthly) recurringIds.push(...group.map((g) => g.id));
  }

  const apply = db.transaction(() => {
    db.prepare("UPDATE transactions SET is_recurring = 0").run();
    const mark = db.prepare("UPDATE transactions SET is_recurring = 1 WHERE id = ?");
    for (const id of recurringIds) mark.run(id);
  });
  apply();
}
