"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Holding = {
  id: number;
  ticker: string;
  shares: number;
  cost_basis: number;
  price: number | null;
  value: number | null;
  pl: number | null;
  dayMove: number | null;
  changePercent: number | null;
};

type WatchItem = {
  id: number;
  ticker: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
};

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function MoveCell({ value, percent }: { value: number | null; percent: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const up = value >= 0;
  return (
    <span className={cn("tabular-nums", up ? "text-emerald-600 dark:text-emerald-500" : "text-destructive")}>
      {up ? "▲" : "▼"} {usd(Math.abs(value))}
      {percent != null && ` (${Math.abs(percent).toFixed(2)}%)`}
    </span>
  );
}

export function StocksView() {
  const [configured, setConfigured] = useState(true);
  const [quotesError, setQuotesError] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ticker, setTicker] = useState("");
  const [shares, setShares] = useState("");
  const [costBasis, setCostBasis] = useState("");
  const [watchTicker, setWatchTicker] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/stocks");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load stocks");
      setConfigured(data.configured);
      setQuotesError(data.quotesError);
      setHoldings(data.holdings);
      setWatchlist(data.watchlist);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stocks");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addHolding(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "holding",
          ticker: ticker.trim(),
          shares: Number(shares),
          cost_basis: Number(costBasis),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to add holding");
      } else {
        setTicker("");
        setShares("");
        setCostBasis("");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function addWatch(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "watch", ticker: watchTicker.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to add to watchlist");
      } else {
        setWatchTicker("");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(kind: "holding" | "watch", id: number) {
    await fetch(`/api/stocks?kind=${kind}&id=${id}`, { method: "DELETE" });
    await load();
  }

  const totalValue = holdings.reduce((s, h) => s + (h.value ?? 0), 0);
  const totalDayMove = holdings.reduce((s, h) => s + (h.dayMove ?? 0), 0);
  const havePrices = holdings.some((h) => h.value != null);

  return (
    <div className="flex flex-col gap-6">
      {!configured && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No market-data key set. Holdings and watchlist are saved, but quotes need
            FINNHUB_API_KEY (or ALPHAVANTAGE_API_KEY) in .env.local — both have free tiers.
          </CardContent>
        </Card>
      )}
      {quotesError && configured && (
        <p className="text-sm text-destructive">Quotes unavailable: {quotesError}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Portfolio</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {havePrices && (
            <div className="flex flex-wrap gap-8 text-sm">
              <div>
                <p className="text-2xl font-semibold tabular-nums">{usd(totalValue)}</p>
                <p className="text-muted-foreground">total value</p>
              </div>
              <div>
                <p className="text-2xl font-semibold">
                  <MoveCell value={totalDayMove} percent={null} />
                </p>
                <p className="text-muted-foreground">day move</p>
              </div>
            </div>
          )}
          {holdings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No holdings yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ticker</TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Cost basis</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">P/L</TableHead>
                  <TableHead className="text-right">Day</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {holdings.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="font-medium">{h.ticker}</TableCell>
                    <TableCell className="text-right tabular-nums">{h.shares}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(h.cost_basis)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.price != null ? usd(h.price) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.value != null ? usd(h.value) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <MoveCell value={h.pl} percent={null} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoveCell value={h.dayMove} percent={h.changePercent} />
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => remove("holding", h.id)}>
                        ✕
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <form onSubmit={addHolding} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="h-ticker" className="text-xs">Ticker</Label>
              <Input id="h-ticker" value={ticker} onChange={(e) => setTicker(e.target.value)} className="w-24" placeholder="VOO" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="h-shares" className="text-xs">Shares</Label>
              <Input id="h-shares" type="number" min={0} step="any" value={shares} onChange={(e) => setShares(e.target.value)} className="w-28" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="h-cost" className="text-xs">Cost basis / share</Label>
              <Input id="h-cost" type="number" min={0} step="any" value={costBasis} onChange={(e) => setCostBasis(e.target.value)} className="w-32" />
            </div>
            <Button type="submit" disabled={busy || !ticker.trim() || !(Number(shares) > 0)}>
              Add / update
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Watchlist</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {watchlist.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing on the watchlist.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {watchlist.map((w) => (
                <li key={w.id} className="flex items-center gap-3">
                  <span className="w-16 font-medium">{w.ticker}</span>
                  <span className="w-24 text-right tabular-nums">
                    {w.price != null ? usd(w.price) : "—"}
                  </span>
                  <MoveCell value={w.change} percent={w.changePercent} />
                  <Button variant="ghost" size="sm" onClick={() => remove("watch", w.id)}>
                    ✕
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addWatch} className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="w-ticker" className="text-xs">Ticker</Label>
              <Input id="w-ticker" value={watchTicker} onChange={(e) => setWatchTicker(e.target.value)} className="w-24" placeholder="NVDA" />
            </div>
            <Button type="submit" variant="secondary" disabled={busy || !watchTicker.trim()}>
              Watch
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
