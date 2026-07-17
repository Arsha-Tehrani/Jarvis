"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  CONTRIBUTION_PERIODS,
  type ConcentrationSummary,
  type ContributionPeriod,
  type HoldingContribution,
} from "@/lib/stocks/contribution";

// "What's driving your portfolio": which holdings actually account for the
// week's/month's move, so a broad-based move isn't mistaken for one or two
// names (or vice versa). Self-contained like the other stocks cards; the math
// (attribution + concentration) is entirely server-side in the pure module.

type Data = {
  period: ContributionPeriod;
  holdings: HoldingContribution[];
  totalPortfolioDollarChange: number;
  totalPortfolioPercentChange: number | null;
  totalAbsChange: number;
  concentration: ConcentrationSummary | null;
};

const PERIOD_LABELS: Record<ContributionPeriod, string> = { "1w": "1W", "1m": "1M" };
const PERIOD_WORDS: Record<ContributionPeriod, string> = {
  "1w": "this week",
  "1m": "this month",
};

// Same +$1,204 (+13.7%) grammar the P/L cells on this page use.
const usd = (v: number) =>
  `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Move({ value, percent }: { value: number; percent: number | null }) {
  const up = value >= 0;
  return (
    <span className={cn("tabular-nums", up ? "text-gain" : "text-loss")}>
      {up ? "▲" : "▼"} {usd(value)}
      {percent != null && ` (${up ? "+" : "−"}${Math.abs(percent).toFixed(1)}%)`}
    </span>
  );
}

export function StockContributionCard() {
  const [period, setPeriod] = useState<ContributionPeriod>("1w");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: ContributionPeriod) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stocks/contribution?period=${p}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load");
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const withData = (data?.holdings ?? []).filter((h) => h.hasData);
  const noData = (data?.holdings ?? []).filter((h) => !h.hasData);
  // Bar scale: widest bar = the biggest single |contribution|.
  const maxAbs = Math.max(1e-9, ...withData.map((h) => Math.abs(h.dollarContribution ?? 0)));

  const toggle = (
    <div className="flex gap-1" role="tablist" aria-label="Period">
      {CONTRIBUTION_PERIODS.map((p) => (
        <button
          key={p}
          role="tab"
          aria-selected={p === period}
          onClick={() => setPeriod(p)}
          className={cn(
            "rounded-[var(--radius)] border px-2.5 py-1 font-data text-xs",
            p === period
              ? "border-(--accent) bg-accent text-accent-foreground"
              : "border-border text-muted-foreground hover:text-foreground"
          )}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          What&apos;s driving your portfolio
          {toggle}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading && !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">Contribution unavailable right now.</p>
        ) : withData.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No price history for the {PERIOD_WORDS[period]} window yet — nothing to attribute.
          </p>
        ) : (
          <>
            {/* Rollup: total move + concentration one-liner. */}
            <div className="text-sm">
              <p>
                Portfolio moved{" "}
                <Move
                  value={data!.totalPortfolioDollarChange}
                  percent={data!.totalPortfolioPercentChange}
                />{" "}
                {PERIOD_WORDS[period]}.
              </p>
              {data!.concentration && (
                <p className="text-muted-foreground">
                  {data!.concentration.topN} of {data!.concentration.holdingsWithData} holdings
                  account for {Math.round(data!.concentration.coverageFraction * 100)}% of{" "}
                  {PERIOD_WORDS[period]}&apos;s move.
                </p>
              )}
            </div>

            <ul className="flex flex-col gap-1.5">
              {withData.map((h) => {
                const contrib = h.dollarContribution ?? 0;
                const width = `${(Math.abs(contrib) / maxAbs) * 100}%`;
                const up = contrib >= 0;
                return (
                  <li key={h.ticker} className="flex items-center gap-3 text-sm">
                    <span className="w-16 shrink-0 font-medium">{h.ticker}</span>
                    <span className="relative h-4 flex-1 overflow-hidden rounded bg-muted/40">
                      <span
                        className={cn(
                          "absolute inset-y-0 left-0 rounded",
                          up ? "bg-gain/30" : "bg-loss/30"
                        )}
                        style={{ width }}
                      />
                    </span>
                    <span className="w-32 shrink-0 text-right font-data text-[13px]">
                      <Move value={contrib} percent={h.percentReturn} />
                    </span>
                    <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {h.percentOfTotalChange != null
                        ? `${h.percentOfTotalChange.toFixed(1)}%`
                        : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">
              Bars sized by dollar contribution; the last column is each holding&apos;s share of
              the net move.
            </p>

            {/* No-data holdings: flagged, muted, at the bottom — never mixed into
                the ranking, never shown as $0. */}
            {noData.length > 0 && (
              <p className="border-t pt-2 text-xs text-muted-foreground">
                No price data {PERIOD_WORDS[period]} for{" "}
                <span className="font-medium">{noData.map((h) => h.ticker).join(", ")}</span> —
                excluded from the ranking above.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
