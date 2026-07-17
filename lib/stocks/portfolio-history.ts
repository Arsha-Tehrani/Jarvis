// Pure filtering/shaping for the Stocks page's "value over time" chart: no
// DB/network imports, so `node --test` can exercise it directly (same
// pure-core / DB-glue split as lib/stocks/history-core.ts vs. history.ts).
//
// The data comes from the SAME daily net-worth snapshot the Net Worth page
// already draws (18:00 cron + launch catch-up, one row per date) — there is
// no second snapshot mechanism. Each row carries the holdings/cash split the
// snapshot already persists; the Net Worth page only ever plotted the blended
// `total`, so this is a new view over existing data.

export const PORTFOLIO_RANGES = ["1m", "3m", "6m", "1y", "all"] as const;
export type PortfolioRange = (typeof PORTFOLIO_RANGES)[number];

// One input row. `holdings_value`/`cash_value` are nullable because rows
// written before the snapshot stored the breakdown have no split to show —
// they must render as a gap, never a fabricated $0 (see the README note on
// positions-snapshot-replaces-prior-holdings: past share counts aren't
// reliably reconstructable, so we never backfill a number we didn't record).
export type PortfolioSnapshotRow = {
  date: string; // YYYY-MM-DD
  holdings_value: number | null;
  cash_value: number | null;
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
export function filterPortfolioHistory(
  rows: PortfolioSnapshotRow[],
  range: PortfolioRange,
  now: Date = new Date()
): PortfolioHistoryPoint[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const days = RANGE_DAYS[range];
  if (days == null) return sorted;
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
  return sorted.filter((r) => r.date >= cutoff);
}

// True when not one point in the (already range-filtered) series carries a
// holdings/cash split — i.e. only pre-breakdown rows survive the window. The
// chart uses this to fall back to a single blended `total` line with a note,
// rather than drawing two all-gap lines.
export function hasBreakdown(points: PortfolioHistoryPoint[]): boolean {
  return points.some((p) => p.holdings_value != null || p.cash_value != null);
}
