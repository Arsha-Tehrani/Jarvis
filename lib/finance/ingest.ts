import fs from "fs";
import path from "path";
import { getDb } from "@/lib/db";
import {
  importBrokerageHoldings,
  looksLikeBrokerageCsv,
  parseBrokerageCsv,
} from "@/lib/finance/brokerage";
import { categorizeTransactions } from "@/lib/finance/categorize";
import {
  parseCsvStatement,
  parsePdfStatement,
  type ParsedTransaction,
} from "@/lib/finance/parse";

// Import flow: scan /statements for files not yet in the statements table,
// parse (redacting account numbers), store, categorize, re-detect recurring
// charges. Everything stays on this machine.

export type ImportResult = {
  file: string;
  imported: number;
  categorizedBy: string;
  kind?: "statement" | "brokerage";
  llmError?: string;
  error?: string;
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
        imported: 0,
        categorizedBy: "none",
        error: err instanceof Error ? err.message : "import failed",
      });
    }
  }
  if (results.some((r) => r.imported > 0)) detectRecurring();
  return results;
}

async function importOne(dir: string, file: string): Promise<ImportResult> {
  const fullPath = path.join(dir, file);

  // Brokerage exports (Fidelity positions/history) share the drop folder;
  // sniff the header and route them to holdings instead of transactions.
  if (/\.csv$/i.test(file)) {
    const content = fs.readFileSync(fullPath, "utf8");
    if (looksLikeBrokerageCsv(content)) {
      return importBrokerageFile(file, content);
    }
  }

  let rows: ParsedTransaction[];
  if (/\.pdf$/i.test(file)) {
    rows = await parsePdfStatement(fs.readFileSync(fullPath));
  } else {
    rows = parseCsvStatement(fs.readFileSync(fullPath, "utf8"));
  }
  if (rows.length === 0) {
    throw new Error("No transactions found in file");
  }

  const db = getDb();
  // Statement month = most common YYYY-MM among rows.
  const monthCounts = new Map<string, number>();
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
  }
  const month = [...monthCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const insertedIds: number[] = [];
  const insertAll = db.transaction(() => {
    const info = db
      .prepare("INSERT INTO statements (month, file_path) VALUES (?, ?)")
      .run(month, file);
    const statementId = info.lastInsertRowid as number;
    const insert = db.prepare(
      `INSERT INTO transactions (date, amount, merchant, category, raw_description, statement_id)
       VALUES (?, ?, ?, 'Uncategorized', ?, ?)`
    );
    for (const r of rows) {
      const rowInfo = insert.run(r.date, r.amount, r.merchant, r.raw_description, statementId);
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

  return {
    file,
    imported: rows.length,
    categorizedBy: outcome.source,
    llmError: outcome.llmError,
  };
}

// Brokerage CSV → holdings upserts. Recorded in the statements table so
// the same file isn't re-processed; account numbers are never persisted.
function importBrokerageFile(file: string, content: string): ImportResult {
  const { holdings, source } = parseBrokerageCsv(content);
  const result = importBrokerageHoldings(holdings, source);
  getDb()
    .prepare("INSERT INTO statements (month, file_path) VALUES (?, ?)")
    .run(new Date().toISOString().slice(0, 7), file);
  return {
    file,
    imported: result.upserted,
    categorizedBy: `brokerage ${source}`,
    kind: "brokerage",
  };
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
    const similarAmounts = maxAmt - minAmt <= Math.max(2, maxAmt * 0.15);
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
