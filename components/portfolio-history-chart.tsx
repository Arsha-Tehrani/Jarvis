"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  PORTFOLIO_GRANULARITIES,
  PORTFOLIO_RANGES,
  collapseToWeekly,
  hasBreakdown,
  type PortfolioGranularity,
  type PortfolioHistoryPoint,
  type PortfolioRange,
} from "@/lib/stocks/portfolio-history";

// Value over time on the Stocks page, scoped to the INVESTMENT ACCOUNT ONLY:
// stocks (equity holdings, a real ticker price) and cash-equivalent
// (money-market/sweep positions like SPAXX) stack to the investment
// account's own total. Manual bank/checking/savings balances never appear
// here — that blended accounts+holdings view lives on the Net Worth page.
// Drawn from the SAME daily net-worth snapshot the Net Worth page uses (no
// second snapshot mechanism). Self-contained like the other dashboard cards:
// it fetches its own data and degrades quietly (Trackers/Screen-time
// convention) rather than crashing when there isn't enough history yet.

type HistoryResponse = {
  range: PortfolioRange;
  series: PortfolioHistoryPoint[];
  hasBreakdown: boolean;
};

const RANGE_LABELS: Record<PortfolioRange, string> = {
  "1m": "1M",
  "3m": "3M",
  "6m": "6M",
  "1y": "1Y",
  all: "All",
};

const GRANULARITY_LABELS: Record<PortfolioGranularity, string> = {
  daily: "Daily",
  weekly: "Weekly",
};

// Sensible default so a year-plus view isn't a cluttered wall of daily
// points — the user can always override it (see granularityTouched below).
function defaultGranularityFor(range: PortfolioRange): PortfolioGranularity {
  return range === "1m" ? "daily" : "weekly";
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function axisDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fullDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function PortfolioHistoryChart() {
  const [range, setRange] = useState<PortfolioRange>("3m");
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [granularity, setGranularity] = useState<PortfolioGranularity>(
    defaultGranularityFor("3m")
  );
  // Once the user picks a granularity directly, range changes stop
  // overriding it — "reasonable default, but let the user override either
  // way rather than locking granularity to range."
  const [granularityTouched, setGranularityTouched] = useState(false);

  const load = useCallback(async (r: PortfolioRange) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stocks/portfolio-history?range=${r}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load history");
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  function changeRange(r: PortfolioRange) {
    setRange(r);
    if (!granularityTouched) setGranularity(defaultGranularityFor(r));
  }

  function changeGranularity(g: PortfolioGranularity) {
    setGranularity(g);
    setGranularityTouched(true);
  }

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

  const granularitySelector = (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label="Granularity">
      {PORTFOLIO_GRANULARITIES.map((g) => (
        <button
          key={g}
          role="tab"
          aria-selected={g === granularity}
          onClick={() => changeGranularity(g)}
          className={cn(
            "rounded-[var(--radius)] border px-2.5 py-1 font-data text-xs",
            g === granularity
              ? "border-(--accent) bg-accent text-accent-foreground"
              : "border-border text-muted-foreground hover:text-foreground"
          )}
        >
          {GRANULARITY_LABELS[g]}
        </button>
      ))}
    </div>
  );

  // Weekly collapsing runs entirely client-side over the already-fetched
  // daily series (lib/stocks/portfolio-history.ts's collapseToWeekly, pure)
  // — toggling granularity never refetches from the API, so there's no
  // loading flash. Only a range change triggers a network request.
  const series = data?.series ?? [];
  const displaySeries = useMemo(
    () => (granularity === "weekly" ? collapseToWeekly(series) : series),
    [series, granularity]
  );
  // Recomputed against displaySeries (not the server's flag for the daily
  // series): collapsing to weekly can change which points survive, e.g. a
  // week whose LAST day predates the stocks/cash split while an earlier day
  // in that week had it.
  const seriesHasBreakdown = hasBreakdown(displaySeries);

  // Quiet unavailable states, matching the app's convention: a chart needs at
  // least two points to draw a trend (a new install has 0–1 snapshots).
  const enoughData = displaySeries.length >= 2;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          Investment account — value over time
          <span className="flex flex-wrap items-center gap-2">
            {granularitySelector}
            {rangeSelector}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">
            History unavailable right now.
          </p>
        ) : !enoughData ? (
          <p className="text-sm text-muted-foreground">
            Not enough history yet — a daily snapshot is taken at 18:00 (and on app
            launch), so this fills in over the next few days.
          </p>
        ) : seriesHasBreakdown ? (
          <div>
            <div className="mb-2 flex gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[2px] bg-gain" />
                Stocks
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[2px] bg-cash-equivalent" />
                Cash (investment account)
              </span>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={displaySeries} stackOffset="none">
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={axisDate}
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v) => usd(Number(v))}
                  width={64}
                />
                <Tooltip
                  labelFormatter={(d) => fullDate(String(d))}
                  formatter={(value, name) => [usd(Number(value)), name]}
                  cursor={{ stroke: "var(--ink-soft)", strokeWidth: 1 }}
                  contentStyle={{
                    borderRadius: "var(--radius)",
                    border: "1px solid var(--border)",
                    background: "var(--background)",
                    color: "var(--foreground)",
                    fontSize: 12,
                  }}
                />
                {/* Stacked: stocks (bottom) + cash-equivalent (top) = the
                    investment account's own total at the band's top edge.
                    connectNulls=false so pre-breakdown rows gap. Genuinely
                    distinct hues (green vs. teal), not shades of one gray. */}
                <Area
                  type="monotone"
                  dataKey="stocks_value"
                  name="Stocks"
                  stackId="worth"
                  stroke="var(--gain)"
                  fill="var(--gain)"
                  fillOpacity={0.35}
                  strokeWidth={1.75}
                  connectNulls={false}
                  dot={false}
                />
                <Area
                  type="monotone"
                  dataKey="cash_equivalent_value"
                  name="Cash (investment account)"
                  stackId="worth"
                  stroke="var(--cash-equivalent)"
                  fill="var(--cash-equivalent)"
                  fillOpacity={0.35}
                  strokeWidth={1.75}
                  connectNulls={false}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          // Only pre-breakdown snapshots survive the window: no stocks/cash
          // split to show, so plot the investment account's own total alone
          // with a note rather than two all-gap lines.
          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              Stocks/cash split isn&apos;t recorded for this period — showing the
              investment account&apos;s total.
            </p>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={displaySeries}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={axisDate}
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v) => usd(Number(v))}
                  width={64}
                />
                <Tooltip
                  labelFormatter={(d) => fullDate(String(d))}
                  formatter={(value) => [usd(Number(value)), "Total"]}
                  cursor={{ stroke: "var(--ink-soft)", strokeWidth: 1 }}
                  contentStyle={{
                    borderRadius: "var(--radius)",
                    border: "1px solid var(--border)",
                    background: "var(--background)",
                    color: "var(--foreground)",
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="var(--ink-soft)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
