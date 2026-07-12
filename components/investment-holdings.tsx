"use client";

import { useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Holding = {
  id: number;
  ticker: string;
  shares: number;
  cost_basis: number;
  priced: boolean;
  value: number;
  percentOfPortfolio: number | null;
};

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Finance page's Investment tab: current positions, reusing the exact same
// /api/stocks endpoint (and lib/stocks/portfolio-total.ts valuation) the
// Stocks page uses — one valuation function, now a fourth consumer, never a
// second parallel computation. Read-only here; edit holdings on Stocks.
export function InvestmentHoldings() {
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/stocks")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setHoldings(body.holdings ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load holdings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!holdings) return <p className="text-sm text-muted-foreground">Loading holdings…</p>;
  if (holdings.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No holdings yet — import a Fidelity (or other brokerage) statement above.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Ticker</TableHead>
          <TableHead className="text-right">Shares</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">% of portfolio</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="font-data text-[13px]">
        {holdings.map((h) => (
          <TableRow key={h.id}>
            <TableCell className="font-medium">
              {h.ticker}
              {!h.priced && (
                <span className="ml-1 text-xs text-muted-foreground">(cost basis)</span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">{h.shares}</TableCell>
            <TableCell className="text-right tabular-nums">{usd(h.value)}</TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {h.percentOfPortfolio != null ? `${h.percentOfPortfolio.toFixed(1)}%` : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
