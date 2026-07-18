// Pure filtering/shaping for the Stocks page's "value over time" chart: no
// DB/network imports, so `node --test` can exercise it directly (same
// pure-core / DB-glue split as lib/stocks/history-core.ts vs. history.ts).
//
// The data comes from the SAME daily net-worth snapshot the Net Worth page
// already draws (18:00 cron + launch catch-up, one row per date) — there is
// no second snapshot mechanism. This chart is scoped to the INVESTMENT
// ACCOUNT ONLY: `stocks_value` (equity holdings, a real ticker price) and
// `cash_equivalent_value` (money-market/sweep positions like SPAXX). Manual
// bank/checking/savings balances (`accounts_total`) never appear here — that
// blended accounts+holdings view lives exactly once, on the Net Worth page.

export const PORTFOLIO_RANGES = ["1m", "3m", "6m", "1y", "all"] as const;
export type PortfolioRange = (typeof PORTFOLIO_RANGES)[number];

export const PORTFOLIO_GRANULARITIES = ["daily", "weekly"] as const;
export type PortfolioGranularity = (typeof PORTFOLIO_GRANULARITIES)[number];

// One input row. `stocks_value`/`cash_equivalent_value` are nullable because
// rows written before the snapshot stored this split have no breakdown to
// show — they must render as a gap, never a fabricated $0 (see the README
// note on positions-snapshot-replaces-prior-holdings: past share counts
// aren't reliably reconstructable, so we never backfill a number we didn't
// record). `total` here is the investment account's own total
// (stocks + cash-equivalent), NOT the Net Worth page's blended total.
export type PortfolioSnapshotRow = {
  date: string; // YYYY-MM-DD
  stocks_value: number | null;
  cash_equivalent_value: number | null;
  total: number;
};

export type PortfolioHistoryPoint = PortfolioSnapshotRow;

// Range → lookback window in days; `all` (null) keeps everything.
const RANGE_DAYS: Record<PortfolioRange, number | null> = {
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
  all: null,
};

const DAY_MS = 86_400_000;

// Filter to the range window and sort oldest-first — the shape Recharts wants.
// The cutoff is inclusive (a snapshot taken exactly `days` ago still counts),
// and rows keep their null breakdown untouched so the chart can gap them.
// Collapses to one point per ISO week when `granularity` is 'weekly' — done
// client-side over whatever the range already returned, no second API call
// (the API always serves daily rows; 'all' is at most one row per calendar
// day since the snapshot began, comfortably small enough to collapse here).
export function filterPortfolioHistory(
  rows: PortfolioSnapshotRow[],
  range: PortfolioRange,
  now: Date = new Date(),
  granularity: PortfolioGranularity = "daily"
): PortfolioHistoryPoint[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const days = RANGE_DAYS[range];
  const windowed = days == null
    ? sorted
    : sorted.filter((r) => r.date >= new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10));
  return granularity === "weekly" ? collapseToWeekly(windowed) : windowed;
}

// The ISO 8601 week a YYYY-MM-DD date falls in, as a sortable "YYYY-Www" key
// (weeks start Monday; week 1 is the week containing the year's first
// Thursday — the standard ISO definition, so a late-December date correctly
// keys into week 1 of the following year when applicable).
function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const isoWeekday = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - isoWeekday + 3); // Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Weekday);
  const weekNum = Math.round((d.getTime() - week1Monday.getTime()) / (7 * DAY_MS)) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
}

// Collapses each ISO week to a single point: the LAST available snapshot in
// that week (never an average — matches how this codebase already treats
// EOD/point-in-time data elsewhere, e.g. dividend/price history). A week
// with only one snapshot, or a gap on some days, still resolves correctly —
// whatever's the latest date present in that week wins. A partial trailing
// week (today mid-week) still gets a point from whatever's available so far.
// Assumes `points` is already sorted oldest-first.
export function collapseToWeekly(points: PortfolioHistoryPoint[]): PortfolioHistoryPoint[] {
  const byWeek = new Map<string, PortfolioHistoryPoint>();
  for (const p of points) {
    // Map.set on an existing key updates the value but keeps its original
    // insertion position — so the map ends up oldest-week-first with each
    // week's value being whichever point was seen LAST (latest date) for it.
    byWeek.set(isoWeekKey(p.date), p);
  }
  return [...byWeek.values()];
}

// True when not one point in the (already range-filtered) series carries a
// stocks/cash-equivalent split — i.e. only pre-breakdown rows survive the
// window. The chart uses this to fall back to a single `total` line with a
// note, rather than drawing two all-gap lines.
export function hasBreakdown(points: PortfolioHistoryPoint[]): boolean {
  return points.some((p) => p.stocks_value != null || p.cash_equivalent_value != null);
}
