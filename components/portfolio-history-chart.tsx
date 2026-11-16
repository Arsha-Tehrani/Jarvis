"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  PORTFOLIO_RANGES,
  rangeChange,
  toChartSeries,
  type ChartPoint,
  type ChartSeries,
  type PortfolioGranularity,
  type PortfolioHistoryPoint,
  type PortfolioRange,
} from "@/lib/stocks/portfolio-history";
import {
  applyCashToggle,
  etDate,
  intradayChange,
  sessionBounds,
  sessionTicks,
  type IntradayTotals,
} from "@/lib/stocks/portfolio-intraday";

// Value over time on the Stocks page, scoped to the INVESTMENT ACCOUNT ONLY:
// stocks (equity holdings, a real ticker price) and cash-equivalent
// (money-market/sweep positions like SPAXX). Manual bank/checking/savings
// balances never appear here — that blended view lives on the Net Worth page.
// Drawn from the SAME daily net-worth snapshot the Net Worth page uses (no
// second snapshot mechanism).
//
// Brokerage-style: one row of range buttons (1D … All) and the resolution
// follows the range automatically (daily, weekly past ~13 months). The x-axis
// is real time, so missing days take their true width; short gaps are drawn
// across and long ones break the line (lib/stocks/portfolio-history.ts's
// toChartSeries). A "Cash" toggle hides the sweep/money-market band so the
// stocks line can use a tight y-axis instead of sitting on a $0 baseline.
//
// 1D is the exception to all of that: there is no snapshot for a session
// that is still happening, so it values today's positions at intraday prices
// (lib/stocks/portfolio-intraday.ts). Its axis is the fixed 9:30 AM–4:00 PM
// ET session rather than the plotted span, so a partial day fills from the
// left and leaves the rest empty the way a brokerage app does, and its
// header change is measured from the previous close (the dashed reference
// line) rather than from the first point of the day.

type HistoryResponse = {
  range: PortfolioRange;
  granularity: PortfolioGranularity | "intraday";
  // Raw snapshot rows on 1w…all; already chart-shaped points on 1d.
  series: PortfolioHistoryPoint[] | ChartPoint[];
  hasBreakdown: boolean;
  // 1d only.
  session?: string | null;
  prevCloseTotal?: IntradayTotals;
  intradayFallbackLabel?: string | null;
};

const RANGE_LABELS: Record<PortfolioRange, string> = {
  "1d": "1D",
  "1w": "1W",
  "1m": "1M",
  "3m": "3M",
  "6m": "6M",
  ytd: "YTD",
  "1y": "1Y",
  all: "All",
};

// While 1D is selected the session is still moving. The per-(ticker,
// interval) intraday cache in lib/stocks/history.ts is already 15 minutes,
// which is what bounds the Yahoo call rate — this poll just keeps the view
// from going stale, and adds no caching of its own.
const INTRADAY_POLL_MS = 5 * 60 * 1000;

// Per-viewer conveniences only (remembered range / cash toggle) — wrapped so
// a blocked or empty storage never breaks the chart.
const RANGE_KEY = "jarvis.portfolioChart.range";
const CASH_KEY = "jarvis.portfolioChart.showCash";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore — the choice just won't be remembered
  }
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const usdCents = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ET = "America/New_York";

function axisDate(t: number, spanDays: number): string {
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    ...(spanDays > 400 ? { year: "2-digit" } : { day: "numeric" }),
    timeZone: "UTC",
  });
}

// "10 AM", "12 PM" — on-the-hour ET labels for the 1D axis.
function axisTime(t: number): string {
  return new Date(t)
    .toLocaleTimeString("en-US", { hour: "numeric", timeZone: ET })
    .replace(/\s/g, " ");
}

function fullDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// "Fri, Nov 13" in ET, for the session label.
function sessionLabel(session: string): string {
  return new Date(sessionBounds(session).open).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: ET,
  });
}

// The 1D tooltip's heading: the session date plus the bar's time of day.
function fullTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: ET,
  })} · ${d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: ET,
  })} ET`;
}

// ~5 evenly spaced, day-aligned ticks across the plotted span.
function timeTicks(min: number, max: number): number[] {
  if (max <= min) return [min];
  const DAY = 86_400_000;
  const count = 5;
  const step = (max - min) / (count - 1);
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    // Points sit at 12:00 UTC; snap each tick to its day's noon (floor, not
    // round — rounding a noon timestamp lands on the next day).
    ticks.push(Math.floor((min + step * i) / DAY) * DAY + DAY / 2);
  }
  return [...new Set(ticks)];
}

// Round step for ~4 y-axis intervals: 1, 2, 2.5 or 5 × 10^k.
function niceStep(span: number): number {
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

// y-axis bounds + ticks on round dollar values. A stacked stocks+cash band
// keeps its $0 baseline (the band's height IS the value); a stocks-only line
// gets a tight, padded range so its movement is readable, like a brokerage
// chart. `alsoFit` pulls an extra value into range — on 1D that's the
// previous close, so its dashed reference line can never sit off-chart.
function yAxis(
  points: ChartPoint[],
  showCash: boolean,
  mode: "split" | "total",
  alsoFit?: number | null
): { domain: [number, number]; ticks: number[] } {
  const vals = points
    .map((p) => (mode === "total" ? p.total : showCash ? p.total : p.stocks))
    .filter((v): v is number => v != null);
  if (alsoFit != null) vals.push(alsoFit);
  if (vals.length === 0) return { domain: [0, 1], ticks: [0, 1] };
  const hi = Math.max(...vals);
  const fromZero = mode === "split" && showCash;
  const lo = fromZero ? 0 : Math.min(...vals);
  const pad = fromZero ? 0 : Math.max((hi - lo) * 0.1, hi * 0.005, 1);
  const step = niceStep(Math.max(hi + pad - (lo - pad), 1));
  const min = Math.max(0, Math.floor((lo - pad) / step) * step);
  const max = Math.ceil((hi + pad) / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  return { domain: [min, max], ticks };
}

type TooltipProps = {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
  showCash: boolean;
  mode: "split" | "total";
  intraday: boolean;
};

function ChartTooltip({ active, payload, showCash, mode, intraday }: TooltipProps) {
  const p = payload?.[0]?.payload;
  if (!active || !p || p.date == null) return null; // break markers have no tooltip
  const row = (label: string, value: number | null, swatch?: string) =>
    value == null ? null : (
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {swatch && <span className={cn("inline-block size-2 rounded-[2px]", swatch)} />}
          {label}
        </span>
        <span className="font-data tabular-nums">{usdCents(value)}</span>
      </div>
    );
  return (
    <div className="rounded-[var(--radius)] border border-border bg-background px-3 py-2 text-xs text-foreground shadow-sm">
      <div className="mb-1 font-medium">
        {intraday ? fullTimestamp(p.date) : fullDate(p.date)}
      </div>
      {mode === "total" ? (
        row("Total", p.total)
      ) : (
        <>
          {row("Stocks", p.stocks, "bg-gain")}
          {showCash && row("Cash", p.cash, "bg-cash-equivalent")}
          {showCash && row("Total", p.total)}
        </>
      )}
    </div>
  );
}

export function PortfolioHistoryChart() {
  const [range, setRange] = useState<PortfolioRange>("3m");
  const [showCash, setShowCash] = useState(true);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The ET calendar date as of the last successful fetch — see load().
  const [todayEt, setTodayEt] = useState<string | null>(null);

  // Restore the remembered range / cash choice after mount (storage isn't
  // available during server render).
  useEffect(() => {
    const r = readStored(RANGE_KEY);
    if (r && (PORTFOLIO_RANGES as readonly string[]).includes(r)) setRange(r as PortfolioRange);
    if (readStored(CASH_KEY) === "0") setShowCash(false);
  }, []);

  const load = useCallback(async (r: PortfolioRange, { quiet = false } = {}) => {
    // A background refresh must not flash the loading state over a chart
    // that's already drawn.
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`/api/stocks/portfolio-history?range=${r}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load history");
      setData(body);
      // Captured at fetch time rather than read during render: "is the
      // session on screen today?" must not be recomputed from the clock on
      // every re-render (it would be an impure read, and the answer can only
      // change when we refetch anyway).
      setTodayEt(etDate(Date.now()));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  // While 1D is selected, refresh every 5 minutes — but only while the tab is
  // actually visible, and catching up once on the way back so a tab left open
  // overnight doesn't show yesterday.
  useEffect(() => {
    if (range !== "1d") return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = setInterval(() => void load("1d", { quiet: true }), INTRADAY_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load("1d", { quiet: true });
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [range, load]);

  function changeRange(r: PortfolioRange) {
    setRange(r);
    writeStored(RANGE_KEY, r);
  }

  function toggleCash() {
    setShowCash((prev) => {
      writeStored(CASH_KEY, prev ? "0" : "1");
      return !prev;
    });
  }

  // Only trust the intraday shape once the response for 1d has actually
  // arrived — mid-switch, `data` still holds the previous range's payload.
  const intraday = data?.range === "1d" && range === "1d";
  const session = intraday ? (data?.session ?? null) : null;
  const prevCloseTotal = intraday ? data?.prevCloseTotal : undefined;

  const chart = useMemo<ChartSeries>(() => {
    if (intraday) {
      // Already chart-shaped by the API; only the Cash toggle is applied here.
      return {
        points: applyCashToggle((data?.series ?? []) as ChartPoint[], showCash),
        mode: "split",
      };
    }
    return toChartSeries((data?.series ?? []) as PortfolioHistoryPoint[], {
      includeCash: showCash,
    });
  }, [data, showCash, intraday]);

  const plotted = chart.points.filter((p) => p.date != null);
  // One intraday bar is still a session (it renders as a dot); the snapshot
  // ranges need two points before a line means anything.
  const enoughData = intraday ? plotted.length >= 1 : plotted.length >= 2;

  const prevCloseRef =
    prevCloseTotal == null ? null : showCash ? prevCloseTotal.total : prevCloseTotal.stocks;
  const summary = intraday
    ? prevCloseTotal == null
      ? rangeChange(chart, showCash)
      : intradayChange(
          { points: chart.points, prevCloseTotal, session, mode: "split" },
          showCash
        )
    : rangeChange(chart, showCash);

  // 1D pins the axis to the whole 9:30–4:00 ET session so a partial day
  // fills from the left; every other range spans its plotted data.
  const bounds = session ? sessionBounds(session) : null;
  const tMin = bounds ? bounds.open : (plotted[0]?.t ?? 0);
  const tMax = bounds ? bounds.close : (plotted[plotted.length - 1]?.t ?? 0);
  const spanDays = (tMax - tMin) / 86_400_000;
  const y = yAxis(chart.points, showCash, chart.mode, prevCloseRef);
  const yMin = y.domain[0];
  const stocksOnly = chart.mode === "split" && !showCash;

  // A lone point after a long break can't be drawn as an area — give it a dot.
  const isolatedDot = (color: string) =>
    function IsolatedDot(props: { cx?: number; cy?: number; payload?: ChartPoint; index?: number }) {
      const { cx, cy, payload, index } = props;
      if (!payload?.isolated || cx == null || cy == null) return <g key={index} />;
      return <circle key={index} cx={cx} cy={cy} r={3} fill={color} stroke={color} />;
    };

  const rangeSelector = (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label="Range">
      {PORTFOLIO_RANGES.map((r) => (
        <button
          key={r}
          role="tab"
          aria-selected={r === range}
          onClick={() => changeRange(r)}
          className={cn(
            "rounded-[var(--radius)] border px-2.5 py-1 font-data text-xs",
            r === range
              ? "border-(--accent) bg-accent text-accent-foreground"
              : "border-border text-muted-foreground hover:text-foreground"
          )}
        >
          {RANGE_LABELS[r]}
        </button>
      ))}
    </div>
  );

  const cashToggle = (
    <button
      type="button"
      aria-pressed={showCash}
      onClick={toggleCash}
      disabled={chart.mode === "total"}
      title={
        chart.mode === "total"
          ? "No stocks/cash split recorded for this period"
          : showCash
            ? "Hide the cash (money-market) band"
            : "Show the cash (money-market) band"
      }
      className={cn(
        "flex items-center gap-1.5 rounded-[var(--radius)] border px-2.5 py-1 font-data text-xs disabled:opacity-50",
        showCash
          ? "border-(--accent) bg-accent text-accent-foreground"
          : "border-border text-muted-foreground hover:text-foreground"
      )}
    >
      <span
        className={cn(
          "inline-block size-2.5 rounded-[2px] border border-cash-equivalent",
          showCash && "bg-cash-equivalent"
        )}
      />
      Cash
    </button>
  );

  const valueLabel =
    chart.mode === "total" ? "Account total" : showCash ? "Stocks + cash" : "Stocks";

  // Which session 1D is showing. "Today" while the market is open or after
  // today's close; the dated form on a weekend, a holiday, or pre-market,
  // where the latest session is an earlier day and saying "today" would lie.
  const whichSession =
    session == null
      ? null
      : session === todayEt
        ? "Today"
        : `Last session · ${sessionLabel(session)}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          Investment account — value over time
          <span className="flex flex-wrap items-center gap-2">
            {cashToggle}
            {rangeSelector}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">History unavailable right now.</p>
        ) : !enoughData ? (
          intraday ? (
            // A closed market is not an error — stay quiet about it.
            <p className="text-sm text-muted-foreground">No trading data for today yet.</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not enough history in this range yet — a daily snapshot is taken at 18:00 (and
              on app launch), so this fills in over time.
            </p>
          )
        ) : (
          <div>
            {summary && (
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-data text-2xl tabular-nums">{usdCents(summary.last)}</span>
                <span
                  className={cn(
                    "font-data text-sm tabular-nums",
                    summary.change >= 0 ? "text-gain" : "text-loss"
                  )}
                >
                  {summary.change >= 0 ? "+" : "−"}
                  {usdCents(Math.abs(summary.change))}
                  {summary.pct != null &&
                    ` (${summary.change >= 0 ? "+" : "−"}${Math.abs(summary.pct * 100).toFixed(2)}%)`}
                </span>
                <span className="text-xs text-muted-foreground">
                  {valueLabel} · {whichSession ?? RANGE_LABELS[range]}
                  {intraday && " · since prev close"}
                  {data?.granularity === "weekly" && " · weekly points"}
                </span>
              </div>
            )}
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={chart.points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={[tMin, tMax]}
                  ticks={session ? sessionTicks(session) : timeTicks(tMin, tMax)}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(t) =>
                    intraday ? axisTime(Number(t)) : axisDate(Number(t), spanDays)
                  }
                  allowDataOverflow
                />
                <YAxis
                  domain={y.domain}
                  ticks={y.ticks}
                  allowDataOverflow
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v) => usd(Number(v))}
                  width={64}
                />
                <Tooltip
                  content={
                    <ChartTooltip showCash={showCash} mode={chart.mode} intraday={!!intraday} />
                  }
                  cursor={{ stroke: "var(--ink-soft)", strokeWidth: 1 }}
                />
                {/* Where the day started. The header's change is measured
                    from this line, so it has to be on the chart. */}
                {prevCloseRef != null && (
                  <ReferenceLine
                    y={prevCloseRef}
                    stroke="var(--ink-soft)"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    label={{
                      value: "Prev close",
                      position: "insideTopLeft",
                      fontSize: 10,
                      fill: "var(--muted-foreground)",
                    }}
                  />
                )}
                {chart.mode === "total" ? (
                  <Area
                    type="monotone"
                    dataKey="total"
                    name="Total"
                    stroke="var(--ink-soft)"
                    fill="var(--ink-soft)"
                    fillOpacity={0.12}
                    strokeWidth={2}
                    baseValue={yMin}
                    connectNulls={false}
                    dot={isolatedDot("var(--ink-soft)")}
                    isAnimationActive={false}
                  />
                ) : (
                  <>
                    {/* Stocks on the bottom; with cash shown, cash stacks on
                        top so the band's top edge is the account total. */}
                    <Area
                      type="monotone"
                      dataKey="stocks"
                      name="Stocks"
                      stackId={showCash ? "worth" : undefined}
                      stroke="var(--gain)"
                      fill="var(--gain)"
                      fillOpacity={stocksOnly ? 0.18 : 0.35}
                      strokeWidth={stocksOnly ? 2 : 1.75}
                      baseValue={stocksOnly ? yMin : undefined}
                      connectNulls={false}
                      dot={isolatedDot("var(--gain)")}
                      isAnimationActive={false}
                    />
                    {showCash && (
                      <Area
                        type="monotone"
                        dataKey="cash"
                        name="Cash (investment account)"
                        stackId="worth"
                        stroke="var(--cash-equivalent)"
                        fill="var(--cash-equivalent)"
                        fillOpacity={0.35}
                        strokeWidth={1.75}
                        connectNulls={false}
                        dot={isolatedDot("var(--cash-equivalent)")}
                        isAnimationActive={false}
                      />
                    )}
                  </>
                )}
              </AreaChart>
            </ResponsiveContainer>
            {intraday && data?.intradayFallbackLabel && (
              <p className="mt-2 text-xs text-muted-foreground">
                {data.intradayFallbackLabel}
              </p>
            )}
            {chart.mode === "total" && (
              <p className="mt-2 text-xs text-muted-foreground">
                Stocks/cash split isn&apos;t recorded for this period — showing the investment
                account&apos;s total.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
