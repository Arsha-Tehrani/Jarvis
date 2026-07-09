"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  priced: boolean;
  price: number | null;
  value: number | null;
  percentOfPortfolio: number | null;
  pl: number | null;
  plPercent: number | null;
  dayMove: number | null;
  changePercent: number | null;
};

type DividendEvent = {
  id: number;
  ticker: string;
  ex_date: string;
  amount_per_share: number;
  shares_at_date: number | null;
  note: string | null;
  payout: number;
  approximate: boolean;
};
type DividendData = {
  total: number;
  byHolding: Array<{ ticker: string; total: number; events: number; approximate: boolean }>;
  events: DividendEvent[];
};

// Client-side sort spec for the holdings table (D1).
type SortKey = "ticker" | "value" | "dayMove" | "pl" | "percentOfPortfolio";
type SortState = { key: SortKey; dir: "asc" | "desc" };

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
  const [sort, setSort] = useState<SortState>({ key: "value", dir: "desc" });
  const [dividends, setDividends] = useState<DividendData | null>(null);
  const [divTicker, setDivTicker] = useState("");
  const [divDate, setDivDate] = useState("");
  const [divAmount, setDivAmount] = useState("");
  const [historyTicker, setHistoryTicker] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<{ date: string; close: number }[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Click a ticker → fetch its cached-or-fresh daily history (lazy, never
  // proactive for the whole table — see docs/stock-history-feasibility.md).
  async function openHistory(t: string) {
    setHistoryTicker(t);
    setHistoryData(null);
    setHistoryError(null);
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/stocks/history?ticker=${encodeURIComponent(t)}`);
      const body = await res.json();
      if (!res.ok || body.error) setHistoryError(body.error ?? "Failed to load price history");
      else setHistoryData(body.series);
    } catch {
      setHistoryError("Could not reach the API.");
    } finally {
      setHistoryLoading(false);
    }
  }

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
    try {
      const res = await fetch("/api/stocks/dividends");
      if (res.ok) setDividends(await res.json());
    } catch {
      // dividend card just shows its empty state
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Click a header: same column flips direction, new column starts descending
  // (except ticker, which starts A→Z). Pure client-side over fetched rows.
  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "ticker" ? "asc" : "desc" }
    );
  }

  const sortedHoldings = [...holdings].sort((a, b) => {
    let cmp: number;
    if (sort.key === "ticker") cmp = a.ticker.localeCompare(b.ticker);
    else cmp = (a[sort.key] ?? -Infinity) - (b[sort.key] ?? -Infinity);
    return sort.dir === "asc" ? cmp : -cmp;
  });

  const caret = (key: SortKey) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");

  async function logDividend(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number(divAmount);
    if (!divTicker.trim() || !divDate || !(amount > 0)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/stocks/dividends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: divTicker.trim(),
          ex_date: divDate,
          amount_per_share: amount,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to log dividend");
      } else {
        setDivTicker("");
        setDivDate("");
        setDivAmount("");
        setDividends(await res.json());
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeDividend(id: number) {
    const res = await fetch(`/api/stocks/dividends?id=${id}`, { method: "DELETE" });
    if (res.ok) setDividends(await res.json());
  }

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
  const havePrices = holdings.length > 0;
  // Holdings with no live quote are counted at cost basis; name how many so the
  // total isn't mistaken for fully market-priced.
  const costBasisCount = holdings.filter((h) => !h.priced).length;

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
                <p className="text-muted-foreground">
                  total value
                  {costBasisCount > 0 && (
                    <span> · {costBasisCount} at cost basis (no live quote)</span>
                  )}
                </p>
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
                  <TableHead>
                    <button className="hover:underline" onClick={() => toggleSort("ticker")}>
                      Ticker{caret("ticker")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Cost basis</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">
                    <button className="hover:underline" onClick={() => toggleSort("value")}>
                      Value{caret("value")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      className="hover:underline"
                      onClick={() => toggleSort("percentOfPortfolio")}
                    >
                      % of portfolio{caret("percentOfPortfolio")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button className="hover:underline" onClick={() => toggleSort("pl")}>
                      P/L{caret("pl")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button className="hover:underline" onClick={() => toggleSort("dayMove")}>
                      Day{caret("dayMove")}
                    </button>
                  </TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedHoldings.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="font-medium">
                      <button className="hover:underline" onClick={() => openHistory(h.ticker)}>
                        {h.ticker}
                      </button>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{h.shares}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(h.cost_basis)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.price != null ? usd(h.price) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.value != null ? usd(h.value) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {h.percentOfPortfolio != null ? `${h.percentOfPortfolio.toFixed(1)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <MoveCell value={h.pl} percent={h.plPercent} />
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-baseline justify-between">
            Dividend income
            <span className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-500">
              {usd(dividends?.total ?? 0)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            Free-tier quote APIs don&apos;t provide dividends, so log them here. Payout =
            shares × amount/share; without a share count for the ex-date it uses your
            current shares, marked <span className="italic">≈</span>.
          </p>
          {dividends && dividends.byHolding.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {dividends.byHolding.map((b) => (
                <li key={b.ticker} className="flex items-center gap-3">
                  <span className="w-16 font-medium">{b.ticker}</span>
                  <span className="w-24 text-right tabular-nums">{usd(b.total)}</span>
                  <span className="text-muted-foreground">
                    {b.events} event{b.events === 1 ? "" : "s"}
                    {b.approximate && " ≈"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {dividends && dividends.events.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {dividends.events.map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="tabular-nums">{e.ex_date}</span>
                  <span className="font-medium text-foreground">{e.ticker}</span>
                  <span className="tabular-nums">
                    ${e.amount_per_share.toFixed(2)}/sh → {usd(e.payout)}
                    {e.approximate && " ≈"}
                  </span>
                  <button className="underline-offset-2 hover:underline" onClick={() => removeDividend(e.id)}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={logDividend} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="d-ticker" className="text-xs">Ticker</Label>
              <Input id="d-ticker" value={divTicker} onChange={(e) => setDivTicker(e.target.value)} className="w-24" placeholder="VOO" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="d-date" className="text-xs">Ex-date</Label>
              <Input id="d-date" type="date" value={divDate} onChange={(e) => setDivDate(e.target.value)} className="w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="d-amount" className="text-xs">$ / share</Label>
              <Input id="d-amount" type="number" min={0} step="any" value={divAmount} onChange={(e) => setDivAmount(e.target.value)} className="w-28" />
            </div>
            <Button type="submit" variant="secondary" disabled={busy || !divTicker.trim() || !divDate || !(Number(divAmount) > 0)}>
              Log dividend
            </Button>
          </form>
        </CardContent>
      </Card>

      <Dialog open={historyTicker != null} onOpenChange={(open) => !open && setHistoryTicker(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{historyTicker} — daily close</DialogTitle>
          </DialogHeader>
          {historyLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : historyError ? (
            <p className="text-sm text-destructive">{historyError}</p>
          ) : historyData && historyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={historyData}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  minTickGap={40}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v) => `$${v}`}
                  width={56}
                />
                <Tooltip
                  formatter={(v) => [`$${Number(v).toFixed(2)}`, "Close"]}
                  contentStyle={{
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--background)",
                    color: "var(--foreground)",
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="close"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground">No data.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
