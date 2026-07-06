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

// PDF → text lines → try to read "date … description … amount" per line.
// Bank PDFs vary wildly; this is best-effort and failures surface clearly.
export async function parsePdfStatement(buffer: Buffer): Promise<ParsedTransaction[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text: string;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  const rows: ParsedTransaction[] = [];
  const lineRe =
    /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\s+(.+?)\s+(-?\$?\(?\d[\d,]*\.\d{2}\)?)$/;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = lineRe.exec(line);
    if (!m) continue;
    const date = parseDate(m[1]);
    const amount = parseAmount(m[3]);
    if (!date || amount == null || Number.isNaN(amount)) continue;
    const desc = redactAccountNumbers(m[2].trim());
    rows.push({
      date,
      amount,
      merchant: normalizeMerchant(desc),
      raw_description: desc,
    });
  }
  if (rows.length === 0) {
    throw new Error(
      "No transaction lines recognized in PDF — export the statement as CSV instead."
    );
  }
  return rows;
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
