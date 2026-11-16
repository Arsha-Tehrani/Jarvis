// Pure shaping for the Stocks chart's "1D" (today, intraday) range: no
// DB/network imports, so `node --test` can exercise it directly — the same
// pure-core / DB-glue split as lib/stocks/history-core.ts vs. history.ts and
// lib/stocks/portfolio-history.ts vs. its API route.
//
// WHY THIS IS NOT portfolio-history.ts: every other range (1W … All) reads
// the daily net-worth snapshot — one recorded row per past date, with the
// share counts that were true on that date. 1D has no snapshot to read: the
// session is still happening. So it values TODAY'S positions (the live
// holdings table) at intraday prices for the whole session. That is the same
// thing a brokerage app does, and it has one visible consequence worth
// stating plainly: a trade made today shows at the NEW share count across the
// entire day, not just from the moment it filled. Intraday values are never
// written to networth_snapshots — this range is computed on every request and
// persists nothing (the 15-minute stock_chart_cache in history.ts is the only
// thing keeping Yahoo calls down).
//
// Cash-equivalents (SPAXX and friends, see cash-equivalents.ts) are never
// fetched intraday: a money-market fund has no meaningful intraday price, and
// Yahoo serves one stale NAV bar for them anyway (history-core.ts's
// isSparseIntraday documents that). They are drawn as a flat line for the
// session, so the cash band behaves exactly as it does on the other ranges.

import { etDate, etInstant } from "./history-core.ts";
import type { ChartPoint, ChartSeries } from "./portfolio-history";

// Re-exported so the chart component has one import for everything 1D.
export { etDate } from "./history-core.ts";

// One holding as this module needs it. `is_cash_equivalent` accepts SQLite's
// 0/1 as well as a real boolean, matching cash-equivalents.ts's ValuedHolding.
export type IntradayHolding = {
  ticker: string;
  shares: number;
  cost_basis: number;
  is_cash_equivalent: boolean | number;
};

// A 5-minute bar, in lib/stocks/history-core.ts's PricePoint shape: `date` is
// a full ISO timestamp for intraday granularity.
export type IntradayBar = { date: string; close: number };

export type IntradayInput = {
  holdings: IntradayHolding[];
  // Intraday bars per EQUITY ticker. A ticker missing from this map (its
  // fetch failed, or it is a cash-equivalent we deliberately never fetch)
  // simply has no bars — carry-forward then holds it at its previous close
  // for the whole session, which is the documented per-ticker failure mode.
  barsByTicker: Record<string, IntradayBar[]>;
  // Previous close per ticker (price − change from the live quote). This is
  // the last REAL price for a ticker, used before its first bar of the
  // session and for a ticker with no bars at all. Never substitute $0.
  prevCloseByTicker: Record<string, number | null>;
  // Current price for cash-equivalents only (their money-market quote).
  // Falls back to the ticker's previous close, then to cost basis — the same
  // cost-basis fallback computePortfolioTotal uses for an unpriced holding,
  // so an unquotable core position is still counted rather than dropped.
  cashPriceByTicker?: Record<string, number | null>;
};

export type IntradayTotals = {
  stocks: number;
  cash: number;
  total: number;
};

export type IntradaySeries = {
  points: ChartPoint[];
  // Both at the previous close: the chart's dashed "Prev close" reference
  // line and the header's change-since-yesterday are measured from here, not
  // from the first plotted point (the first bar already contains the
  // overnight gap, so measuring from it would hide the day's real move).
  prevCloseTotal: IntradayTotals;
  // YYYY-MM-DD in America/New_York of the session being shown, or null when
  // there were no bars at all. May be a past date on a weekend/holiday or
  // pre-market — the UI labels which session it is rather than implying today.
  session: string | null;
  mode: ChartSeries["mode"];
};

// ---------------------------------------------------------------------------
// Eastern-time session window
// ---------------------------------------------------------------------------
//
// The ET date/offset primitives live in history-core.ts, which already owns
// the notion of a trading session (its `sessions` trim is keyed the same
// way) — one definition, used by both the per-ticker chart and this one.

export const MARKET_OPEN_ET = "09:30";
export const MARKET_CLOSE_ET = "16:00";

// The fixed x-axis domain for a session: 9:30 AM – 4:00 PM ET. A partial day
// fills from the left and leaves the rest empty, the way a brokerage app
// draws an in-progress session.
export function sessionBounds(session: string): { open: number; close: number } {
  return {
    open: etInstant(session, MARKET_OPEN_ET),
    close: etInstant(session, MARKET_CLOSE_ET),
  };
}

// The x-axis tick times, on the hour in ET — the sparse "10 AM / 12 PM /
// 2 PM / 4 PM" labelling a brokerage day chart uses, rather than evenly
// dividing the span (which would land on ragged times like 11:48).
export const TICK_HOURS_ET = ["10:00", "12:00", "14:00", "16:00"] as const;

export function sessionTicks(session: string): number[] {
  return TICK_HOURS_ET.map((h) => etInstant(session, h));
}

/** True when an instant falls inside its own ET date's regular session. */
export function isRegularHours(ms: number): boolean {
  const { open, close } = sessionBounds(etDate(ms));
  return ms >= open && ms <= close;
}

// Yahoo's 5-minute bars include PRE- and POST-market trading — verified live
// 2026-11-15 against the Friday 2026-11-13 session, which came back as 113
// bars running 07:25–19:59 ET, not 09:30–16:00. Those extended-hours bars
// have to go: the axis is the regular session, so they would be clipped off
// the left and right edges, and the last one (a thin 19:59 print) would
// become the "latest value" in the header instead of the 4 PM close.
//
// Picks the LATEST ET date that has at least one regular-hours bar, then
// keeps only that session's regular-hours bars. Choosing the session from
// regular-hours bars specifically is what stops a few pre-market prints from
// being mistaken for a session that hasn't opened yet.
function pickSession(allBars: number[]): string | null {
  const sessions = new Set<string>();
  for (const ms of allBars) if (isRegularHours(ms)) sessions.add(etDate(ms));
  if (sessions.size === 0) return null;
  return [...sessions].sort().at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

function isCash(h: IntradayHolding): boolean {
  return !!h.is_cash_equivalent;
}

// A holding's per-share price before it has any bar: its previous close (the
// last real price), else cost basis. Never 0 — an unpriced holding is valued
// at cost basis everywhere else in this app, and a $0 point would draw a
// cliff that never happened.
function fallbackPrice(h: IntradayHolding, prevClose: number | null | undefined): number {
  return prevClose ?? h.cost_basis;
}

/**
 * Values today's positions at intraday prices across one session.
 *
 * Timeline: the union of every equity ticker's bar timestamps, sorted. At
 * each timestamp a ticker contributes `shares × its latest bar close at or
 * before that time` — so a ticker whose bars start later, or that is missing
 * a bar, holds its last known price instead of dropping out, and a later
 * price is never used for an earlier time. Before a ticker's first bar it
 * contributes its previous close.
 */
export function buildIntradaySeries({
  holdings,
  barsByTicker,
  prevCloseByTicker,
  cashPriceByTicker = {},
}: IntradayInput): IntradaySeries {
  const equities = holdings.filter((h) => !isCash(h));
  const cashHoldings = holdings.filter(isCash);

  const key = (t: string) => t.toUpperCase();
  const barsFor = (h: IntradayHolding): IntradayBar[] => {
    const bars = barsByTicker[key(h.ticker)] ?? [];
    // Defensive sort: callers pass parseYahooChart output, which is already
    // oldest-first, but carry-forward depends on it so don't assume.
    return [...bars]
      .filter((b) => Number.isFinite(Date.parse(b.date)) && Number.isFinite(b.close))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  };

  // One pass to choose the session, then keep only that session's regular
  // trading hours (Yahoo hands back pre/post-market bars too — see
  // pickSession).
  const session = pickSession(
    equities.flatMap((h) => barsFor(h).map((b) => Date.parse(b.date)))
  );
  const window = session ? sessionBounds(session) : null;
  const inSession = (b: IntradayBar): boolean => {
    if (!window) return false;
    const ms = Date.parse(b.date);
    return ms >= window.open && ms <= window.close;
  };

  const equitySeries = equities.map((h) => ({
    holding: h,
    bars: barsFor(h).filter(inSession),
    prevClose: fallbackPrice(h, prevCloseByTicker[key(h.ticker)]),
    cursor: 0,
    // Last close seen at or before the current timestamp; null until the
    // ticker's first bar, where prevClose stands in.
    carried: null as number | null,
  }));

  // Cash-equivalents are one flat value for the whole session.
  const cashValue = cashHoldings.reduce((sum, h) => {
    const price =
      cashPriceByTicker[key(h.ticker)] ?? prevCloseByTicker[key(h.ticker)] ?? h.cost_basis;
    return sum + price * h.shares;
  }, 0);

  const prevCloseStocks = equities.reduce(
    (sum, h) => sum + fallbackPrice(h, prevCloseByTicker[key(h.ticker)]) * h.shares,
    0
  );
  const prevCloseTotal: IntradayTotals = {
    stocks: prevCloseStocks,
    cash: cashValue,
    total: prevCloseStocks + cashValue,
  };

  const timeline = [
    ...new Set(equitySeries.flatMap((e) => e.bars.map((b) => Date.parse(b.date)))),
  ].sort((a, b) => a - b);

  if (timeline.length === 0) {
    // No bars anywhere: no session to draw. The UI shows a quiet empty state,
    // not an error — a closed market is not a failure.
    return { points: [], prevCloseTotal, session: null, mode: "split" };
  }

  const points: ChartPoint[] = timeline.map((t) => {
    let stocks = 0;
    for (const e of equitySeries) {
      // Advance this ticker's cursor over every bar at or before t. The
      // cursor only moves forward, so the whole walk is O(bars) overall.
      while (e.cursor < e.bars.length && Date.parse(e.bars[e.cursor].date) <= t) {
        e.carried = e.bars[e.cursor].close;
        e.cursor++;
      }
      stocks += (e.carried ?? e.prevClose) * e.holding.shares;
    }
    return {
      t,
      date: new Date(t).toISOString(),
      stocks,
      cash: cashValue,
      total: stocks + cashValue,
      isolated: false,
    };
  });

  // A single-bar session can't be drawn as an area — give it a dot, the same
  // convention toChartSeries uses for a lone point after a long break.
  if (points.length === 1) points[0].isolated = true;

  return { points, prevCloseTotal, session, mode: "split" };
}

/**
 * Applies the Cash toggle to an already-built intraday series, matching what
 * toChartSeries does for the other ranges: hiding cash nulls the band so the
 * stocks line can use a tight y-axis, and leaves stocks/total untouched (the
 * shared headlineValue picks stocks over total when cash is hidden).
 */
export function applyCashToggle(points: ChartPoint[], includeCash: boolean): ChartPoint[] {
  return includeCash ? points : points.map((p) => ({ ...p, cash: null }));
}

/**
 * The header's figure for 1D: change measured from the PREVIOUS CLOSE rather
 * than the first plotted point. With fresh quotes for every ticker this
 * equals computePortfolioTotal's totalDayMove to the cent — see
 * tests/portfolio-intraday.test.ts. (Mid-session the two can differ by a few
 * cents, because the chart's last point is the last completed 5-minute bar
 * while the live quote has moved on. That is honest: the chart shows bar
 * data, so its header is measured in bar data.)
 */
export function intradayChange(
  series: IntradaySeries,
  includeCash: boolean
): { last: number; change: number; pct: number | null } | null {
  const last = series.points[series.points.length - 1];
  if (!last) return null;
  const value = includeCash ? last.total : last.stocks;
  if (value == null) return null;
  const base = includeCash ? series.prevCloseTotal.total : series.prevCloseTotal.stocks;
  return { last: value, change: value - base, pct: base !== 0 ? (value - base) / base : null };
}
