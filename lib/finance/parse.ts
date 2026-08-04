// Statement parsing: CSV directly, PDF via text extraction first, then both
// become the same normalized rows. Account numbers are redacted on ingest —
// nothing identity-laden is stored or ever sent to the LLM.

export type ParsedTransaction = {
  date: string; // YYYY-MM-DD
  amount: number; // negative = money out, positive = money in
  merchant: string;
  raw_description: string;
};

// Mask digit runs of 8+ (allowing space/dash groupings), keeping last 4.
export function redactAccountNumbers(text: string): string {
  return text.replace(/\d(?:[ -]?\d){7,}/g, (match) => {
    const digits = match.replace(/\D/g, "");
    return `••••${digits.slice(-4)}`;
  });
}

// Uppercased, de-numbered merchant label for grouping and display.
export function normalizeMerchant(description: string): string {
  const cleaned = description
    .toUpperCase()
    .replace(/[•*#]/g, " ")
    .replace(/\b\d{3,}\b/g, " ") // store / reference numbers
    .replace(/\b(POS|DEBIT|CREDIT|PURCHASE|PAYMENT|ACH|WEB|RECURRING|CHECKCARD|VISA|MC)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 4).join(" ");
  return words || "UNKNOWN";
}

export function parseCsvStatement(content: string): ParsedTransaction[] {
  const table = parseCsv(content);
  if (table.length < 2) return [];
  const header = table[0].map((h) => h.trim().toLowerCase());

  const dateCol = findCol(header, ["transaction date", "posted date", "trans date", "date"]);
  const descCol = findCol(header, ["description", "merchant", "payee", "name", "details", "memo"]);
  const amountCol = findCol(header, ["amount", "transaction amount"]);
  const debitCol = findCol(header, ["debit", "withdrawal", "withdrawals", "money out"]);
  const creditCol = findCol(header, ["credit", "deposit", "deposits", "money in"]);

  if (dateCol < 0 || descCol < 0 || (amountCol < 0 && debitCol < 0 && creditCol < 0)) {
    throw new Error(
      `Unrecognized CSV columns [${header.join(", ")}] — need date, description, and amount (or debit/credit).`
    );
  }

  const rows: ParsedTransaction[] = [];
  for (const cells of table.slice(1)) {
    if (cells.every((c) => c.trim() === "")) continue;
    const date = parseDate(cells[dateCol] ?? "");
    if (!date) continue; // footer/summary lines
    let amount: number | null = null;
    if (amountCol >= 0) {
      amount = parseAmount(cells[amountCol] ?? "");
    } else {
      const debit = debitCol >= 0 ? parseAmount(cells[debitCol] ?? "") : null;
      const credit = creditCol >= 0 ? parseAmount(cells[creditCol] ?? "") : null;
      if (debit != null && debit !== 0) amount = -Math.abs(debit);
      else if (credit != null && credit !== 0) amount = Math.abs(credit);
    }
    if (amount == null || Number.isNaN(amount)) continue;
    const raw = redactAccountNumbers((cells[descCol] ?? "").trim());
    rows.push({
      date,
      amount,
      merchant: normalizeMerchant(raw),
      raw_description: raw,
    });
  }
  return rows;
}

// A brokerage/investment report (Fidelity, Schwab, …) is a holdings summary,
// not a list of dated transactions. Parsing one as checking transactions
// produced garbage before; we detect and refuse it, pointing at the CSV
// positions export (which the brokerage importer handles) instead.
export class BrokerageStatementError extends Error {
  constructor() {
    super(
      "This looks like a brokerage/investment report, not a transaction statement — " +
        "export a positions/history CSV for holdings, or a CSV of transactions."
    );
    this.name = "BrokerageStatementError";
  }
}

export function isBrokerageStatement(text: string): boolean {
  return (
    /INVESTMENT REPORT|Brokerage services provided|Your Account Value|Ending Account Value|Holdings? as of|Realized Gain\/Loss/i.test(
      text
    ) &&
    // Real transaction statements have a running-balance or payment-due
    // structure; investment reports don't. Guards against false positives.
    !/DATE\s+DESCRIPTION\s+AMOUNT\s+BALANCE|Minimum Payment Due/i.test(text)
  );
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

export async function parsePdfStatement(buffer: Buffer): Promise<ParsedTransaction[]> {
  return parsePdfText(await extractPdfText(buffer));
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// The statement's period end (year + month), used to give year-less MM/DD
// transaction lines a real year. Scans the header for MM/DD/YY(YY) and
// "Month DD, YYYY" dates and takes the latest; falls back to the most common
// 20YY in the document, then the current year.
export function inferPeriodEnd(text: string): { year: number; month: number } {
  const head = text.slice(0, 3000);
  const candidates: { year: number; month: number }[] = [];
  for (const m of head.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g)) {
    const month = Number(m[1]);
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (month >= 1 && month <= 12) candidates.push({ year, month });
  }
  for (const m of head.matchAll(/\b([A-Za-z]+)\s+\d{1,2},?\s+(20\d{2})\b/g)) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month) candidates.push({ year: Number(m[2]), month });
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.year - b.year || a.month - b.month);
    return candidates[candidates.length - 1];
  }
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.length > 0) {
    const freq = new Map<number, number>();
    for (const y of years) freq.set(y, (freq.get(y) ?? 0) + 1);
    const best = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { year: best, month: 12 };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

// MM/DD at the start of a transaction line. The day must NOT be followed by
// another digit or a slash, so a full metadata date like "07/13/26" can't
// backtrack into "07/1" and leak "3/26" as a bogus transaction.
const DATE_START = /^(\d{1,2})\/(\d{1,2})(?![\d/])/;
const DECIMAL = /-?\s?\$?\(?\d[\d,]*\.\d{2}\)?/g;
// Lines that close a transaction record instead of continuing it — summaries,
// page furniture, column headers. None begin with a MM/DD date.
const BOUNDARY =
  /^(date\b|beginning balance|ending balance|deposits and|atm & debit|electronic with|total\b|subtotal|balance\b|page \d|--? \d|previous balance|new balance|minimum payment|account number|statement)/i;

type TxnRecord = { month: number; day: number; text: string };

// Group flat text lines into transaction records: a record begins at a line
// starting MM/DD and absorbs up to two following wrap lines (bank PDFs break
// long descriptions across lines). Boundary/summary lines end the record.
export function groupRecords(lines: string[]): TxnRecord[] {
  const records: TxnRecord[] = [];
  let current: TxnRecord | null = null;
  let wraps = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const d = DATE_START.exec(line);
    if (d) {
      if (current) records.push(current);
      current = { month: Number(d[1]), day: Number(d[2]), text: line };
      wraps = 0;
    } else if (current) {
      if (BOUNDARY.test(line)) {
        records.push(current);
        current = null;
      } else if (wraps < 2) {
        current.text += " " + line;
        wraps++;
      }
    }
  }
  if (current) records.push(current);
  return records;
}

function decimalsIn(text: string): number[] {
  return (text.match(DECIMAL) ?? []).map((s) => parseAmount(s)).filter(
    (n): n is number => n != null && !Number.isNaN(n)
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function describe(record: TxnRecord): string {
  // Strip the leading MM/DD and any trailing money columns.
  let text = record.text.replace(DATE_START, "").trim();
  text = text.replace(new RegExp(`(?:\\s*${DECIMAL.source})+\\s*$`), "").trim();
  return redactAccountNumbers(text);
}

// Pure parser over already-extracted PDF text. Two layouts:
//  - checking (DATE DESCRIPTION AMOUNT BALANCE): amounts derived from the
//    running-balance delta, so deposit lines that print only a balance still
//    get the right signed amount;
//  - credit card (DATE DESCRIPTION AMOUNT, no balance): the single trailing
//    number is the amount, sign-flipped so purchases read as money out.
export function parsePdfText(text: string): ParsedTransaction[] {
  if (isBrokerageStatement(text)) throw new BrokerageStatementError();

  const lines = text.split(/\r?\n/);
  const { year, month: endMonth } = inferPeriodEnd(text);
  const yearFor = (m: number) => (m <= endMonth ? year : year - 1);

  const balanceMode =
    /DATE\s+DESCRIPTION\s+AMOUNT\s+BALANCE/i.test(text) ||
    /Beginning Balance\s*\$?[\d,]+\.\d{2}/i.test(text);

  const records = groupRecords(lines);
  const rows: ParsedTransaction[] = [];

  if (balanceMode) {
    const begin = /Beginning Balance\s*\$?([\d,]+\.\d{2})/i.exec(text);
    let prevBalance = begin ? parseAmount(begin[1]) : null;
    for (const rec of records) {
      const nums = decimalsIn(rec.text);
      if (nums.length === 0) continue;
      const balance = nums[nums.length - 1];
      let amount: number | null;
      if (prevBalance != null) {
        amount = round2(balance - prevBalance);
      } else if (nums.length >= 2) {
        amount = nums[nums.length - 2]; // explicit amount column
      } else {
        continue; // deposit line with no seed balance — can't tell
      }
      prevBalance = balance; // keep the running-balance chain intact even if we skip below
      const date = makeDate(yearFor(rec.month), rec.month, rec.day);
      if (!date || amount == null || Number.isNaN(amount) || amount === 0) continue;
      const desc = describe(rec);
      if (!hasPayeeName(desc)) continue; // numeric noise, not a transaction
      rows.push({ date, amount, merchant: normalizeMerchant(desc), raw_description: desc });
    }
  } else {
    for (const rec of records) {
      const nums = decimalsIn(rec.text);
      if (nums.length === 0) continue;
      // Credit card: purchases are positive on the statement but are money
      // out; flip so the sign matches the checking convention.
      const amount = round2(-nums[nums.length - 1]);
      const date = makeDate(yearFor(rec.month), rec.month, rec.day);
      if (!date || Number.isNaN(amount) || amount === 0) continue;
      const desc = describe(rec);
      if (!hasPayeeName(desc)) continue; // numeric noise, not a transaction
      rows.push({ date, amount, merchant: normalizeMerchant(desc), raw_description: desc });
    }
  }

  if (rows.length === 0) {
    throw new Error(
      "No transaction lines recognized in PDF — export the statement as CSV instead."
    );
  }
  return rows;
}

// The statement's summary balance, for the net-worth suggestion. Checking
// statements print "Ending Balance $X" (an asset → cash); credit-card
// statements print "New Balance: $X" alongside "Minimum Payment Due" (a
// liability → debt). Returns null when no summary line is found, so we only
// suggest an account update when we're confident what the number means.
//
// `accountLabel` is the classifier's actual sub-type (classify.ts's
// "Checking"/"Savings"/"Credit Card"), so a savings statement suggests a
// "Savings" account instead of colliding with "Checking" — two accounts of
// different real-world types must not merge into one suggestion slot.
// Falls back to the old hardcoded labels when the caller has no sub-type
// (content-ambiguous CSVs still get a sane default, not a missing label).
export type StatementBalance = { balance: number; kind: "cash" | "debt"; label: string };

export function extractStatementBalance(
  text: string,
  accountLabel?: string
): StatementBalance | null {
  const isCard = /Minimum Payment Due|New Balance/i.test(text);
  if (isCard) {
    const m = /New Balance:?\s*\$?([\d,]+\.\d{2})/i.exec(text);
    const bal = m ? parseAmount(m[1]) : null;
    if (bal != null) return { balance: Math.abs(bal), kind: "debt", label: accountLabel ?? "Credit Card" };
  }
  // Prefer the LAST "Ending Balance" (statements repeat it per section).
  const endings = [...text.matchAll(/Ending Balance\s*\$?([\d,]+\.\d{2})/gi)];
  if (endings.length > 0) {
    const bal = parseAmount(endings[endings.length - 1][1]);
    if (bal != null) return { balance: Math.abs(bal), kind: "cash", label: accountLabel ?? "Checking" };
  }
  return null;
}

// A real transaction always names a payee/merchant. Requiring a couple of
// letters drops numeric fragments that a date-led line can otherwise produce.
function hasPayeeName(description: string): boolean {
  return (description.match(/[A-Za-z]/g) ?? []).length >= 2;
}

function makeDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// --- helpers ---

function findCol(header: string[], names: string[]): number {
  for (const name of names) {
    const exact = header.indexOf(name);
    if (exact >= 0) return exact;
  }
  for (const name of names) {
    const partial = header.findIndex((h) => h.includes(name));
    if (partial >= 0) return partial;
  }
  return -1;
}

// Minimal RFC-4180-ish parser: quoted fields, escaped quotes, CR/LF.
// Exported for the brokerage importer, which shares the same muscle.
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && content[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // US bank convention MM/DD/YYYY (or M/D/YY)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

function parseAmount(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true; // accounting style (12.34)
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const value = Number(s);
  return negative ? -value : value;
}
