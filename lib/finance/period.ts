// Period logic for a statement-based app. "This month" must come from the DATA
// (the most recent transaction actually imported), never the system clock —
// statements lag, so the clock's calendar month is reliably empty. These are
// pure functions over the list of YYYY-MM months that have transactions; the
// DB-backed accessors that feed them live in query.ts. Kept import-free so the
// math is unit-tested directly.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// The most recent month present. Months are "YYYY-MM", which sort
// lexicographically the same as chronologically.
export function latestPeriod(months: string[]): string | null {
  if (months.length === 0) return null;
  return months.reduce((a, b) => (b > a ? b : a));
}

// The calendar month immediately before `period` ("2026-01" → "2025-12").
export function previousMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  return `${prevY}-${String(prevM).padStart(2, "0")}`;
}

// The month to compare the latest against: the immediately-preceding calendar
// month, but ONLY if it actually has transactions. A gap (no adjacent prior
// month) returns null so the UI can say "not enough history yet" instead of
// showing a misleading $0-vs-$0 comparison against a non-adjacent month.
export function comparisonPeriod(months: string[]): string | null {
  const latest = latestPeriod(months);
  if (!latest) return null;
  const prev = previousMonth(latest);
  return months.includes(prev) ? prev : null;
}

// "2026-06" → "June 2026" for plain-language UI labels.
export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const name = MONTH_NAMES[m - 1];
  if (!name) return period;
  return `${name} ${y}`;
}
