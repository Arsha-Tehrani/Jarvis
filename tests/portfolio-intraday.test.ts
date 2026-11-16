import assert from "node:assert/strict";
import { test } from "node:test";
import { computePortfolioTotal } from "../lib/stocks/portfolio-total.ts";
import {
  applyCashToggle,
  buildIntradaySeries,
  etDate,
  intradayChange,
  isRegularHours,
  previousCloseFromBars,
  sessionBounds,
  type IntradayBar,
  type IntradayHolding,
} from "../lib/stocks/portfolio-intraday.ts";

// The Stocks chart's "1D" range values TODAY'S positions at intraday prices
// across one session — it has no snapshot to read, unlike 1W…All (see
// tests/portfolio-history.test.ts for those). The whole point of this pure
// module is carry-forward: tickers' 5-minute bars don't line up, so at any
// given timestamp some tickers have a fresh bar and others don't, and the
// total must still be right. Never a $0 for a ticker that simply hasn't
// printed yet, and never a later price used for an earlier time.
//
// Session pinned to Friday 2026-11-13 (EST, UTC−5): 09:30 ET = 14:30Z.

const bar = (hhmmZ: string, close: number): IntradayBar => ({
  date: `2026-11-13T${hhmmZ}:00.000Z`,
  close,
});

const equity = (ticker: string, shares: number, cost_basis = 1): IntradayHolding => ({
  ticker,
  shares,
  cost_basis,
  is_cash_equivalent: 0,
});

const cash = (ticker: string, shares: number, cost_basis = 1): IntradayHolding => ({
  ticker,
  shares,
  cost_basis,
  is_cash_equivalent: 1,
});

// ---------------------------------------------------------------------------
// Carry-forward
// ---------------------------------------------------------------------------

test("a ticker with no bar at t uses its last EARLIER close, never a later one", () => {
  // AAA prints every 5 minutes; BBB prints only at 14:30 and 14:45. At 14:35
  // and 14:40, BBB must still be valued at its 14:30 close (100), NOT at its
  // 14:45 close (200) — that would be using the future to price the past.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1), equity("BBB", 1)],
    barsByTicker: {
      AAA: [bar("14:30", 10), bar("14:35", 11), bar("14:40", 12), bar("14:45", 13)],
      BBB: [bar("14:30", 100), bar("14:45", 200)],
    },
    prevCloseByTicker: { AAA: 9, BBB: 90 },
  });

  assert.deepEqual(
    built.points.map((p) => p.stocks),
    [110, 111, 112, 213]
  );
});

test("before a ticker's first bar it uses its PREVIOUS CLOSE, not $0", () => {
  // BBB's first bar is at 14:40. At 14:30 and 14:35 it must contribute its
  // previous close (90 × 2 shares = 180), so the total never shows a cliff
  // that didn't happen.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1), equity("BBB", 2)],
    barsByTicker: {
      AAA: [bar("14:30", 10), bar("14:35", 10), bar("14:40", 10)],
      BBB: [bar("14:40", 100)],
    },
    prevCloseByTicker: { AAA: 10, BBB: 90 },
  });

  assert.deepEqual(
    built.points.map((p) => p.stocks),
    [10 + 180, 10 + 180, 10 + 200]
  );
  // And nothing is ever zero on the way.
  assert.ok(built.points.every((p) => (p.stocks ?? 0) > 0));
});

test("a ticker with no previous close falls back to cost basis, still never $0", () => {
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 2, 50)],
    barsByTicker: { AAA: [bar("14:45", 60)] },
    prevCloseByTicker: { AAA: null },
  });

  assert.equal(built.prevCloseTotal.stocks, 100); // 2 × cost basis 50
  assert.equal(built.points.at(-1)?.stocks, 120);
});

test("tickers whose bars start at different times give a correct total at EVERY timestamp", () => {
  // Three tickers, three different start times, union timeline of 4 stamps.
  // Each expected value is written out independently of the implementation.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 10), equity("BBB", 5), equity("CCC", 2)],
    barsByTicker: {
      AAA: [bar("14:30", 1), bar("14:35", 2), bar("14:40", 3), bar("14:45", 4)],
      BBB: [bar("14:40", 20), bar("14:45", 30)],
      CCC: [bar("14:35", 500)],
    },
    prevCloseByTicker: { AAA: 1, BBB: 10, CCC: 400 },
  });

  assert.deepEqual(
    built.points.map((p) => p.t),
    [
      Date.parse("2026-11-13T14:30:00.000Z"),
      Date.parse("2026-11-13T14:35:00.000Z"),
      Date.parse("2026-11-13T14:40:00.000Z"),
      Date.parse("2026-11-13T14:45:00.000Z"),
    ]
  );
  assert.deepEqual(
    built.points.map((p) => p.stocks),
    [
      10 * 1 + 5 * 10 + 2 * 400, // BBB & CCC pre-first-bar → prev close
      10 * 2 + 5 * 10 + 2 * 500, // CCC's only bar; BBB still prev close
      10 * 3 + 5 * 20 + 2 * 500, // BBB's first bar; CCC carries 500 forward
      10 * 4 + 5 * 30 + 2 * 500, // CCC still carrying its 14:35 close
    ]
  );
});

test("the full ISO timestamp is kept on each point, so the tooltip can show time of day", () => {
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1)],
    barsByTicker: { AAA: [bar("14:30", 10), bar("19:55", 11)] },
    prevCloseByTicker: { AAA: 10 },
  });
  assert.equal(built.points[0].date, "2026-11-13T14:30:00.000Z");
  assert.equal(built.points[1].date, "2026-11-13T19:55:00.000Z");
});

// ---------------------------------------------------------------------------
// Cash-equivalents
// ---------------------------------------------------------------------------

test("the cash-equivalent line stays flat for the whole session", () => {
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1), cash("SPAXX", 1234.56)],
    barsByTicker: { AAA: [bar("14:30", 10), bar("14:35", 20), bar("14:40", 30)] },
    prevCloseByTicker: { AAA: 10, SPAXX: 1 },
    cashPriceByTicker: { SPAXX: 1 },
  });

  assert.deepEqual(
    built.points.map((p) => p.cash),
    [1234.56, 1234.56, 1234.56]
  );
  // Cash rides on top of stocks in the total, exactly as on the other ranges.
  assert.deepEqual(
    built.points.map((p) => p.total),
    [10 + 1234.56, 20 + 1234.56, 30 + 1234.56]
  );
  assert.equal(built.prevCloseTotal.cash, 1234.56);
  assert.equal(built.prevCloseTotal.stocks, 10);
  assert.equal(built.prevCloseTotal.total, 1244.56);
});

test("NO intraday data is ever requested for a cash-equivalent ticker", () => {
  // Proves the real property rather than restating it: a recording Proxy
  // reports every ticker whose bars were looked up. SPAXX must not be among
  // them even though bars are sitting right there for it.
  const read: string[] = [];
  const barsByTicker = new Proxy(
    {
      AAA: [bar("14:30", 10), bar("14:35", 11)],
      SPAXX: [bar("14:30", 999), bar("14:35", 999)], // a trap: must be ignored
    } as Record<string, IntradayBar[]>,
    {
      get(target, prop: string) {
        read.push(prop);
        return target[prop];
      },
    }
  );

  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1), cash("SPAXX", 100)],
    barsByTicker,
    prevCloseByTicker: { AAA: 10, SPAXX: 1 },
    cashPriceByTicker: { SPAXX: 1 },
  });

  assert.ok(read.includes("AAA"), "the equity ticker's bars are read");
  assert.ok(!read.includes("SPAXX"), "the cash-equivalent's bars are never read");
  // The $999 trap bars never reach the series: cash stays at 100 × $1.
  assert.deepEqual(
    built.points.map((p) => p.cash),
    [100, 100]
  );
});

test("a cash-equivalent with no quote falls back to cost basis rather than vanishing", () => {
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1), cash("SPAXX", 500, 1)],
    barsByTicker: { AAA: [bar("14:30", 10)] },
    prevCloseByTicker: { AAA: 10, SPAXX: null },
  });
  assert.equal(built.points[0].cash, 500);
});

test("the Cash toggle nulls the band and leaves stocks/total alone", () => {
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1), cash("SPAXX", 100)],
    barsByTicker: { AAA: [bar("14:30", 10), bar("14:35", 20)] },
    prevCloseByTicker: { AAA: 10, SPAXX: 1 },
    cashPriceByTicker: { SPAXX: 1 },
  });

  const hidden = applyCashToggle(built.points, false);
  assert.deepEqual(
    hidden.map((p) => p.cash),
    [null, null]
  );
  assert.deepEqual(
    hidden.map((p) => p.stocks),
    [10, 20]
  );
  assert.deepEqual(
    hidden.map((p) => p.total),
    [110, 120]
  );
  // Shown is a no-op passthrough.
  assert.deepEqual(applyCashToggle(built.points, true), built.points);
});

// ---------------------------------------------------------------------------
// Degraded inputs
// ---------------------------------------------------------------------------

test("one ticker failing falls back to its previous close; the others are unaffected", () => {
  // BBB's getStockChart threw, so the route left it out of barsByTicker
  // entirely. It must hold its previous close all session while AAA and the
  // cash band render exactly as they would have.
  const withFailure = buildIntradaySeries({
    holdings: [equity("AAA", 3), equity("BBB", 4), cash("SPAXX", 50)],
    barsByTicker: { AAA: [bar("14:30", 10), bar("14:35", 12), bar("14:40", 15)] },
    prevCloseByTicker: { AAA: 9, BBB: 25, SPAXX: 1 },
    cashPriceByTicker: { SPAXX: 1 },
  });

  assert.deepEqual(
    withFailure.points.map((p) => p.stocks),
    [3 * 10 + 100, 3 * 12 + 100, 3 * 15 + 100]
  );
  assert.deepEqual(
    withFailure.points.map((p) => p.cash),
    [50, 50, 50]
  );

  // AAA's own contribution is byte-identical to a run where BBB never existed.
  const aaaOnly = buildIntradaySeries({
    holdings: [equity("AAA", 3)],
    barsByTicker: { AAA: [bar("14:30", 10), bar("14:35", 12), bar("14:40", 15)] },
    prevCloseByTicker: { AAA: 9 },
  });
  assert.deepEqual(
    withFailure.points.map((p) => (p.stocks ?? 0) - 100),
    aaaOnly.points.map((p) => p.stocks)
  );
});

test("every ticker failing leaves an empty series rather than a flat fabricated line", () => {
  // No bars anywhere means there is no session to draw — the UI shows its
  // quiet empty state. A flat prev-close line would imply we had data.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1), equity("BBB", 1)],
    barsByTicker: {},
    prevCloseByTicker: { AAA: 10, BBB: 20 },
  });
  assert.deepEqual(built.points, []);
  assert.equal(built.session, null);
  // The previous-close total is still known, so the header can say something.
  assert.equal(built.prevCloseTotal.total, 30);
});

test("empty input gives an empty series and does not crash", () => {
  const built = buildIntradaySeries({
    holdings: [],
    barsByTicker: {},
    prevCloseByTicker: {},
  });
  assert.deepEqual(built.points, []);
  assert.equal(built.session, null);
  assert.deepEqual(built.prevCloseTotal, { stocks: 0, cash: 0, total: 0 });
  assert.equal(intradayChange(built, true), null);
});

test("unsorted and malformed bars are tolerated", () => {
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1)],
    barsByTicker: {
      AAA: [
        bar("14:40", 12),
        bar("14:30", 10),
        { date: "not-a-date", close: 999 },
        { date: "2026-11-13T14:35:00.000Z", close: Number.NaN },
        bar("14:35", 11),
      ],
    },
    prevCloseByTicker: { AAA: 9 },
  });
  assert.deepEqual(
    built.points.map((p) => p.stocks),
    [10, 11, 12]
  );
});

test("a single-bar session is marked isolated so it renders as a dot", () => {
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1)],
    barsByTicker: { AAA: [bar("14:30", 10)] },
    prevCloseByTicker: { AAA: 9 },
  });
  assert.equal(built.points.length, 1);
  assert.equal(built.points[0].isolated, true);
});

// ---------------------------------------------------------------------------
// The header figure
// ---------------------------------------------------------------------------

test("the last point's change from prevCloseTotal equals computePortfolioTotal's day move, to the cent", () => {
  // THE invariant that keeps the 1D header honest: the chart's day move and
  // the Stocks page's existing day-move figure are the same number, computed
  // two different ways from the same quotes. Deliberately awkward share
  // counts and prices so an accidental rounding or ordering difference shows.
  const quotes = {
    AAA: { price: 187.43, change: 2.17, changePercent: 1.17 },
    BBB: { price: 41.08, change: -0.93, changePercent: -2.21 },
    CCC: { price: 1314.57, change: 11.06, changePercent: 0.85 },
    // A money-market core position: priced, but no day move.
    SPAXX: { price: 1, change: 0, changePercent: 0 },
  };
  const holdings: IntradayHolding[] = [
    equity("AAA", 13.472, 150),
    equity("BBB", 207.5, 44),
    equity("CCC", 1.8311, 1200),
    cash("SPAXX", 4231.77, 1),
  ];

  // The existing figure, from live quotes.
  const { totalDayMove } = computePortfolioTotal(
    holdings.map((h) => ({ ticker: h.ticker, shares: h.shares, cost_basis: h.cost_basis })),
    (t) => quotes[t as keyof typeof quotes]
  );

  // The chart's figure. "Every ticker has fresh data" means each ticker's
  // LAST bar has caught up to its live quote — that is the condition under
  // which the two must agree (mid-session the last completed 5-minute bar
  // can still lag the quote by a few cents; see intradayChange's comment).
  const prevCloseByTicker = Object.fromEntries(
    Object.entries(quotes).map(([t, q]) => [t, q.price - q.change])
  );
  const built = buildIntradaySeries({
    holdings,
    barsByTicker: {
      AAA: [bar("14:30", 185.9), bar("19:55", quotes.AAA.price)],
      BBB: [bar("14:35", 41.9), bar("19:55", quotes.BBB.price)],
      CCC: [bar("14:30", 1300.0), bar("19:55", quotes.CCC.price)],
    },
    prevCloseByTicker,
    cashPriceByTicker: { SPAXX: quotes.SPAXX.price },
  });

  const cents = (v: number) => v.toFixed(2);

  // With cash shown: the cash band is identical at both ends, so it cancels.
  const withCash = intradayChange(built, true);
  assert.ok(withCash);
  assert.equal(cents(withCash.change), cents(totalDayMove));

  // With cash hidden: SPAXX has no day move, so the stocks-only change is
  // the same number again.
  const stocksOnly = intradayChange(built, false);
  assert.ok(stocksOnly);
  assert.equal(cents(stocksOnly.change), cents(totalDayMove));

  // And it really is a non-trivial figure, not two zeroes agreeing.
  assert.ok(Math.abs(totalDayMove) > 10);
});

test("the header is measured from the previous close, not from the first plotted point", () => {
  // An overnight gap: prev close 10, session opens at 12. Measuring from the
  // first point would report +1 for the day; the truth is +3.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1)],
    barsByTicker: { AAA: [bar("14:30", 12), bar("19:55", 13)] },
    prevCloseByTicker: { AAA: 10 },
  });
  const change = intradayChange(built, false);
  assert.ok(change);
  assert.equal(change.last, 13);
  assert.equal(change.change, 3);
  assert.equal(change.pct, 0.3);
});

test("a zero previous-close base gives a null percentage rather than Infinity", () => {
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1, 0)],
    barsByTicker: { AAA: [bar("14:30", 5)] },
    prevCloseByTicker: { AAA: 0 },
  });
  const change = intradayChange(built, false);
  assert.ok(change);
  assert.equal(change.change, 5);
  assert.equal(change.pct, null);
});

// ---------------------------------------------------------------------------
// Session window (Eastern time, DST-aware)
// ---------------------------------------------------------------------------

test("the session is the ET calendar date of the bars", () => {
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1)],
    barsByTicker: { AAA: [bar("14:30", 10), bar("20:55", 11)] },
    prevCloseByTicker: { AAA: 10 },
  });
  // 20:55Z on 2026-11-13 is 15:55 ET the same day — not the next day.
  assert.equal(built.session, "2026-11-13");
});

test("pre-market and after-hours bars are dropped — the session is 9:30–4:00 ET only", () => {
  // Yahoo's 5-minute bars include extended hours: verified live 2026-11-15,
  // the Friday 2026-11-13 session came back as 113 bars running 07:25–19:59
  // ET. Those would be clipped off the axis, and the 19:59 print would
  // become the header's "latest value" instead of the 4 PM close.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1)],
    barsByTicker: {
      AAA: [
        bar("12:25", 1), // 07:25 ET — pre-market
        bar("14:25", 2), // 09:25 ET — still pre-market, 5 min before the bell
        bar("14:30", 3), // 09:30 ET — the open
        bar("18:00", 4), // 13:00 ET
        bar("20:55", 5), // 15:55 ET — the last regular-hours bar
        bar("21:00", 6), // 16:00 ET — the 16:00–16:05 window, post-market
        bar("21:05", 7), // 16:05 ET — after-hours
        { date: "2026-11-14T00:59:59.000Z", close: 8 }, // 19:59 ET, after-hours
      ],
    },
    prevCloseByTicker: { AAA: 1 },
  });

  assert.deepEqual(
    built.points.map((p) => p.stocks),
    [3, 4, 5]
  );
  assert.equal(built.points[0].date, "2026-11-13T14:30:00.000Z");
  assert.equal(built.points.at(-1)?.date, "2026-11-13T20:55:00.000Z");
  assert.equal(built.session, "2026-11-13");
  // Every point sits inside the axis domain, so nothing can be clipped.
  const { open, close } = sessionBounds("2026-11-13");
  assert.ok(built.points.every((p) => p.t >= open && p.t <= close));
});

test("a session with only extended-hours bars is treated as no session at all", () => {
  // Pre-market on a weekday morning: the bell hasn't rung, so there is no
  // session to draw and the UI shows its quiet empty state rather than
  // plotting thin pre-market prints as if they were the day.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1)],
    barsByTicker: { AAA: [bar("12:25", 1), bar("13:00", 2), bar("14:00", 3)] },
    prevCloseByTicker: { AAA: 1 },
  });
  assert.deepEqual(built.points, []);
  assert.equal(built.session, null);
});

test("isRegularHours is half-open: the 16:00 bar is post-market, not the close", () => {
  // A bar's timestamp is its interval START. 15:55 covers 15:55–16:00 and is
  // the session's last bar; 16:00 covers 16:00–16:05 and is post-market.
  assert.equal(isRegularHours(Date.parse("2026-11-13T14:29:59Z")), false);
  assert.equal(isRegularHours(Date.parse("2026-11-13T14:30:00Z")), true);
  assert.equal(isRegularHours(Date.parse("2026-11-13T20:55:00Z")), true);
  assert.equal(isRegularHours(Date.parse("2026-11-13T21:00:00Z")), false);
});

test("the session's last point is the 15:55 bar, not the 16:00 post-market one", () => {
  // The live bug: VOO's 15:55 bar closed at 693.37 (official close 693.38)
  // while its 16:00 bar closed at 690.50. Plotting the 16:00 bar put the
  // header's day move $57 off the holdings table's on a $10k portfolio.
  const built = buildIntradaySeries({
    holdings: [equity("VOO", 1)],
    barsByTicker: {
      VOO: [bar("20:50", 693.63), bar("20:55", 693.37), bar("21:00", 690.5)],
    },
    prevCloseByTicker: { VOO: 696.0 },
    priorBarsByTicker: {
      // Thursday's close has the same trap: 20:55 is the close, 21:00 isn't.
      VOO: [priorBar("20:55", 696.0), priorBar("21:00", 696.2)],
    },
  });

  const last = built.points[built.points.length - 1];
  assert.equal(last.stocks, 693.37);
  assert.equal(new Date(last.t).toISOString(), "2026-11-13T20:55:00.000Z");
  assert.equal(built.prevCloseTotal.stocks, 696.0);
  // 693.37 − 696.00, both official closes — what the holdings table shows.
  assert.equal(intradayChange(built, false)?.change.toFixed(2), "-2.63");
});

test("sessionBounds is 9:30 AM – 4:00 PM ET, correct across DST", () => {
  // November: EST, UTC−5 → 14:30Z–21:00Z.
  const est = sessionBounds("2026-11-13");
  assert.equal(new Date(est.open).toISOString(), "2026-11-13T14:30:00.000Z");
  assert.equal(new Date(est.close).toISOString(), "2026-11-13T21:00:00.000Z");

  // July: EDT, UTC−4 → 13:30Z–20:00Z. A hardcoded offset would be an hour out.
  const edt = sessionBounds("2026-07-10");
  assert.equal(new Date(edt.open).toISOString(), "2026-07-10T13:30:00.000Z");
  assert.equal(new Date(edt.close).toISOString(), "2026-07-10T20:00:00.000Z");

  assert.equal((est.close - est.open) / 3_600_000, 6.5);
  assert.equal((edt.close - edt.open) / 3_600_000, 6.5);
});

test("etDate rolls over on the ET boundary, not the UTC one", () => {
  // 2026-11-14T02:30Z is still the 13th in ET (21:30).
  assert.equal(etDate(Date.parse("2026-11-14T02:30:00Z")), "2026-11-13");
  assert.equal(etDate(Date.parse("2026-11-14T05:30:00Z")), "2026-11-14");
});

// ---------------------------------------------------------------------------
// Previous close from the ticker's own bars
// ---------------------------------------------------------------------------
//
// The baseline the header measures from used to come from the live quote
// (Finnhub) while the plotted bars came from Yahoo. A subtraction between two
// providers carries their price-level disagreement straight into the answer:
// measured at −$61 on a real portfolio, which is why the chart's day move and
// the holdings table's disagreed. Taking the baseline from the SAME bars the
// chart plots makes that gap cancel. The prior session is already inside the
// 6-day 5m window a 1D plan fetches, so this costs no extra Yahoo call.

// A bar on Thursday 2026-11-12, the session before the pinned Friday.
const priorBar = (hhmmZ: string, close: number): IntradayBar => ({
  date: `2026-11-12T${hhmmZ}:00.000Z`,
  close,
});

test("previousCloseFromBars takes the prior session's last REGULAR-HOURS bar", () => {
  const bars = [
    priorBar("14:30", 100), // 09:30 ET open
    priorBar("20:55", 110), // 15:55 ET — the last regular-hours bar
    priorBar("21:30", 999), // 16:30 ET — post-market, must not win
    bar("14:30", 120), // the session itself, must not win
  ];
  assert.equal(previousCloseFromBars(bars, "2026-11-13"), 110);
});

test("previousCloseFromBars returns null when the superset doesn't reach back", () => {
  // Only the session's own bars — nothing earlier to read a close from.
  assert.equal(previousCloseFromBars([bar("14:30", 120), bar("20:55", 121)], "2026-11-13"), null);
  assert.equal(previousCloseFromBars([], "2026-11-13"), null);
});

test("previousCloseFromBars reads a daily bar too, for the degraded-to-daily path", () => {
  // getStockChart's fallback serves plain YYYY-MM-DD bars. Those ARE closes,
  // so no regular-hours filter applies — and no timezone shift either.
  const daily: IntradayBar[] = [
    { date: "2026-11-11", close: 90 },
    { date: "2026-11-12", close: 110 },
    { date: "2026-11-13", close: 120 },
  ];
  assert.equal(previousCloseFromBars(daily, "2026-11-13"), 110);
});

test("the prior session's close WINS over the quote-derived previous close", () => {
  // The quote says the previous close was 90; the ticker's own prior-session
  // bar says 110. The bars win, so the baseline and the line agree.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 10)],
    barsByTicker: { AAA: [bar("14:30", 120)] },
    prevCloseByTicker: { AAA: 90 },
    priorBarsByTicker: { AAA: [priorBar("20:55", 110), bar("14:30", 120)] },
  });

  assert.equal(built.prevCloseTotal.stocks, 1100);
  // 10 × (120 − 110) = 100, not 10 × (120 − 90) = 300.
  assert.equal(intradayChange(built, false)?.change, 100);
});

test("a ticker whose superset has no prior session falls back to its quote", () => {
  // Mixed portfolio: AAA's superset reaches Thursday, BBB's doesn't. Each
  // holding resolves its own baseline — one missing superset must not drag
  // the other off the bar-derived value.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 10), equity("BBB", 10)],
    barsByTicker: { AAA: [bar("14:30", 120)], BBB: [bar("14:30", 50)] },
    prevCloseByTicker: { AAA: 90, BBB: 45 },
    priorBarsByTicker: { AAA: [priorBar("20:55", 110)], BBB: [bar("14:30", 50)] },
  });

  // AAA from its bars (110), BBB from its quote (45).
  assert.equal(built.prevCloseTotal.stocks, 10 * 110 + 10 * 45);
});

test("a ticker with no bars at all is held at its prior-session close", () => {
  // The per-ticker failure mode: BBB's intraday fetch failed, so it has no
  // bars in the session. It must flat-line at its prior-session close — the
  // bar-derived one, where the superset has it.
  const built = buildIntradaySeries({
    holdings: [equity("AAA", 1), equity("BBB", 2)],
    barsByTicker: { AAA: [bar("14:30", 10), bar("14:35", 12)] },
    prevCloseByTicker: { AAA: 9, BBB: 90 },
    priorBarsByTicker: { BBB: [priorBar("20:55", 110)] },
  });

  assert.equal(built.points.length, 2);
  assert.equal(built.points[0].stocks, 10 + 2 * 110);
  assert.equal(built.points[1].stocks, 12 + 2 * 110);
  // BBB is flat at the SAME baseline it is measured from (110, from its bars
  // — not the quote's 90), so a ticker whose fetch failed contributes nothing
  // to the day move instead of a phantom 2 × $20.
  assert.equal(built.prevCloseTotal.stocks, 9 + 2 * 110);
  assert.equal(intradayChange(built, false)?.change, 12 - 9);
});

test("the day move no longer moves when the quote provider's price LEVEL shifts", () => {
  // The actual bug this fixes. The quote provider's prices sit ~0.6% below
  // Yahoo's last 5-minute bar (its official close includes the closing
  // auction). With the baseline taken from the bars, that level gap cancels:
  // the same bars give the same day move whatever the quotes say.
  const withQuoteLevel = (factor: number) =>
    intradayChange(
      buildIntradaySeries({
        holdings: [equity("AAA", 13.472, 150), equity("BBB", 207.5, 44)],
        barsByTicker: {
          AAA: [bar("14:30", 185.9), bar("20:55", 187.43)],
          BBB: [bar("14:30", 41.9), bar("20:55", 41.08)],
        },
        // The quote-derived baseline, scaled — i.e. a different provider.
        prevCloseByTicker: { AAA: 185.26 * factor, BBB: 42.01 * factor },
        priorBarsByTicker: {
          AAA: [priorBar("20:55", 185.26)],
          BBB: [priorBar("20:55", 42.01)],
        },
      }),
      false
    )?.change;

  const expected = 13.472 * (187.43 - 185.26) + 207.5 * (41.08 - 42.01);
  const base = withQuoteLevel(1);
  // To the cent against the hand-computed figure (the summation order
  // differs, so the last float bit does too).
  assert.equal(base?.toFixed(2), expected.toFixed(2));
  // Exactly unchanged when the quote provider's level moves: the quotes no
  // longer enter the subtraction at all.
  assert.equal(withQuoteLevel(1.006), base);
  assert.equal(withQuoteLevel(0.98), base);
  // And it is a real number, not two zeroes agreeing.
  assert.ok(Math.abs(expected) > 100);
});
