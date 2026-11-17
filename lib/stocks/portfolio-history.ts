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

// Brokerage-style range buttons (1W … All). Resolution is chosen
// automatically per range (see autoGranularity) — there is no separate
// daily/weekly toggle.
export const PORTFOLIO_RANGES = ["1w", "1m", "3m", "6m", "ytd", "1y", "all"] as const;
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

// Range → lookback window in days; `all` (null) keeps everything and `ytd`
// is calendar-based (see rangeStart).
const RANGE_DAYS: Record<Exclude<PortfolioRange, "ytd">, number | null> = {
  "1w": 7,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
  all: null,
};

const DAY_MS = 86_400_000;

// First YYYY-MM-DD (inclusive) a range keeps, or null for `all`.
export function rangeStart(range: PortfolioRange, now: Date = new Date()): string | null {
  if (range === "ytd") return `${now.getUTCFullYear()}-01-01`;
  const days = RANGE_DAYS[range];
  return days == null ? null : new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

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
  const start = rangeStart(range, now);
  const windowed = start == null ? sorted : sorted.filter((r) => r.date >= start);
  return granularity === "weekly" ? collapseToWeekly(windowed) : windowed;
}

// Daily points until a window spans more than ~13 months, then one point per
// week — the way brokerage charts thin out long ranges. Decided from the data
// actually in the window (not the button), so "All" on a young history stays
// daily. Expects an oldest-first series.
export const WEEKLY_AFTER_DAYS = 400;

export function autoGranularity(points: PortfolioSnapshotRow[]): PortfolioGranularity {
  if (points.length < 2) return "daily";
  const span =
    (Date.parse(`${points[points.length - 1].date}T00:00:00Z`) -
      Date.parse(`${points[0].date}T00:00:00Z`)) /
    DAY_MS;
  return span > WEEKLY_AFTER_DAYS ? "weekly" : "daily";
}

// What the API serves: the range window at the automatically chosen resolution.
export function portfolioSeriesFor(
  rows: PortfolioSnapshotRow[],
  range: PortfolioRange,
  now: Date = new Date()
): { series: PortfolioHistoryPoint[]; granularity: PortfolioGranularity } {
  const daily = filterPortfolioHistory(rows, range, now, "daily");
  const granularity = autoGranularity(daily);
  return {
    series: granularity === "weekly" ? collapseToWeekly(daily) : daily,
    granularity,
  };
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

// ---------------------------------------------------------------------------
// Chart shaping
// ---------------------------------------------------------------------------

// A missing stretch up to this long (weekends, the laptop asleep for a few
// days, a snapshot written without the stocks/cash split) is drawn straight
// across — the same thing brokerage charts do over non-trading days. Anything
// longer is drawn as a visible break: we have no idea what happened in there,
// and a line across weeks of missing data would invent a trend.
export const MAX_CONNECT_GAP_DAYS = 7;

export type ChartPoint = {
  t: number; // ms since epoch at 12:00 UTC — the x value on a real time axis
  date: string | null; // null on a break marker
  stocks: number | null;
  cash: number | null; // null when cash is hidden
  total: number | null;
  // True for a point with no plotted neighbour on either side (e.g. one
  // snapshot after a long break). An area/line can't draw a single point,
  // so the chart gives these a dot instead of letting them vanish.
  isolated: boolean;
};

export type ChartSeries = {
  points: ChartPoint[];
  // "split": stocks (+ cash) from the recorded breakdown.
  // "total": no breakdown recorded in this window — the account total only.
  mode: "split" | "total";
};

function noonUtc(date: string): number {
  return Date.parse(`${date}T12:00:00Z`);
}

// Shapes an oldest-first series for a time-scaled chart:
//  - in split mode, rows without a recorded breakdown are skipped rather than
//    plotted as holes — never a fabricated $0, but no hole-punched band either;
//  - a gap longer than MAX_CONNECT_GAP_DAYS between plotted rows gets an
//    all-null break marker so the line visibly stops there;
//  - `includeCash: false` plots stocks only (the cash band disappears).
export function toChartSeries(
  points: PortfolioHistoryPoint[],
  { includeCash }: { includeCash: boolean }
): ChartSeries {
  const mode = hasBreakdown(points) ? "split" : "total";
  const kept =
    mode === "split" ? points.filter((p) => p.stocks_value != null) : points;

  const out: ChartPoint[] = [];
  let prevT: number | null = null;
  for (const p of kept) {
    const t = noonUtc(p.date);
    if (prevT != null && t - prevT > MAX_CONNECT_GAP_DAYS * DAY_MS) {
      out.push({
        t: Math.round((prevT + t) / 2),
        date: null,
        stocks: null,
        cash: null,
        total: null,
        isolated: false,
      });
    }
    const stocks = mode === "split" ? p.stocks_value : null;
    const cash = mode === "split" && includeCash ? (p.cash_equivalent_value ?? 0) : null;
    out.push({
      t,
      date: p.date,
      stocks,
      cash,
      total: mode === "split" ? (stocks ?? 0) + (p.cash_equivalent_value ?? 0) : p.total,
      isolated: false,
    });
    prevT = t;
  }

  for (let i = 0; i < out.length; i++) {
    if (out[i].date == null) continue;
    const prevPlotted = i > 0 && out[i - 1].date != null;
    const nextPlotted = i < out.length - 1 && out[i + 1].date != null;
    out[i].isolated = !prevPlotted && !nextPlotted;
  }
  return { points: out, mode };
}

// The value the chart is "about" for a point: stocks only when cash is
// hidden, otherwise the investment account's total.
export function headlineValue(p: ChartPoint, includeCash: boolean, mode: ChartSeries["mode"]): number | null {
  if (p.date == null) return null;
  if (mode === "total") return p.total;
  return includeCash ? p.total : p.stocks;
}

// Change across the window, first plotted point → last.
export function rangeChange(
  series: ChartSeries,
  includeCash: boolean
): { last: number; change: number; pct: number | null } | null {
  const values = series.points
    .map((p) => headlineValue(p, includeCash, series.mode))
    .filter((v): v is number => v != null);
  if (values.length === 0) return null;
  const first = values[0];
  const last = values[values.length - 1];
  return { last, change: last - first, pct: first !== 0 ? (last - first) / first : null };
}
