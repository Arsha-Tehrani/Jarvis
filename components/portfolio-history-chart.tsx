"use client";

import { useCallback, useEffect, useState } from "react";
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
  PORTFOLIO_RANGES,
  type PortfolioHistoryPoint,
  type PortfolioRange,
} from "@/lib/stocks/portfolio-history";

// Value over time on the Stocks page, drawn from the SAME daily net-worth
// snapshot the Net Worth page uses (no second snapshot mechanism). Holdings
// and cash/account balances stack to the total, so the composition — how much
// of your worth is invested vs. sitting in cash — reads directly off the
// chart. Self-contained like the other dashboard cards: it fetches its own
// data and degrades quietly (Trackers/Screen-time convention) rather than
// crashing when there isn't enough history yet.

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

  const rangeSelector = (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label="Range">
      {PORTFOLIO_RANGES.map((r) => (
        <button
          key={r}
          role="tab"
          aria-selected={r === range}
          onClick={() => setRange(r)}
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

  // Quiet unavailable states, matching the app's convention: a chart needs at
  // least two points to draw a trend (a new install has 0–1 snapshots).
  const series = data?.series ?? [];
  const enoughData = series.length >= 2;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          Value over time
          {rangeSelector}
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
        ) : data?.hasBreakdown ? (
          <div className="[--series-holdings:var(--ink-soft)] [--series-cash:var(--muted-foreground)]">
            <div className="mb-2 flex gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[2px] bg-[var(--series-holdings)]" />
                Holdings
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[2px] bg-[var(--series-cash)] opacity-40" />
                Cash / accounts
              </span>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={series} stackOffset="none">
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
                {/* Stacked: holdings (bottom) + cash (top) = total at the band's
                    top edge. connectNulls=false so pre-breakdown rows gap. */}
                <Area
                  type="monotone"
                  dataKey="holdings_value"
                  name="Holdings"
                  stackId="worth"
                  stroke="var(--series-holdings)"
                  fill="var(--series-holdings)"
                  fillOpacity={0.35}
                  strokeWidth={1.75}
                  connectNulls={false}
                  dot={false}
                />
                <Area
                  type="monotone"
                  dataKey="cash_value"
                  name="Cash / accounts"
                  stackId="worth"
                  stroke="var(--series-cash)"
                  fill="var(--series-cash)"
                  fillOpacity={0.15}
                  strokeWidth={1.5}
                  connectNulls={false}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          // Only pre-breakdown snapshots survive the window: no holdings/cash
          // split to show, so plot the blended total alone with a note rather
          // than two all-gap lines.
          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              Holdings/cash split isn&apos;t recorded for this period — showing total
              net worth.
            </p>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={series}>
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
