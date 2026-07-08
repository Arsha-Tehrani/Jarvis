"use client";

import { useCallback, useEffect, useState } from "react";
import { Sparkline, type SparkPoint } from "@/components/sparkline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const KINDS = ["cash", "savings", "investment", "debt", "other"] as const;

type Account = {
  id: number;
  name: string;
  kind: (typeof KINDS)[number];
  balance: number;
  updated_at: string;
};

type BalanceSuggestion = {
  label: string;
  kind: "cash" | "debt";
  balance: number;
  month: string | null;
  accountId: number | null;
  currentBalance: number | null;
};

type Data = {
  accounts: Account[];
  now: {
    accountsTotal: number;
    holdingsValue: number;
    holdingsPriced: "market" | "cost-basis" | "none";
    total: number;
  };
  snapshots: { date: string; total: number }[];
  weeklyDelta: number | null;
  balanceSuggestions: BalanceSuggestion[];
};

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function NetWorthView() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("cash");
  const [balance, setBalance] = useState("");
  const [edits, setEdits] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/networth");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load");
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || balance === "") return;
    setBusy(true);
    try {
      const res = await fetch("/api/networth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kind, balance: Number(balance) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to add account");
      } else {
        setName("");
        setBalance("");
        setKind("cash");
        setError(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveBalance(account: Account) {
    const raw = edits[account.id];
    if (raw == null || raw === "" || Number(raw) === account.balance) return;
    await fetch("/api/networth", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: account.id, balance: Number(raw) }),
    });
    setEdits((m) => {
      const next = { ...m };
      delete next[account.id];
      return next;
    });
    await load();
  }

  async function remove(account: Account) {
    if (!window.confirm(`Remove account "${account.name}"?`)) return;
    await fetch(`/api/networth?id=${account.id}`, { method: "DELETE" });
    await load();
  }

  // B5: apply a captured statement balance to the matching account. Explicit
  // click only — the write goes through the same confirm-gated accounts
  // endpoint (PATCH an existing account, POST a new one).
  async function applySuggestion(s: BalanceSuggestion) {
    setBusy(true);
    try {
      const res = s.accountId
        ? await fetch("/api/networth", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: s.accountId, balance: s.balance }),
          })
        : await fetch("/api/networth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: s.label, kind: s.kind, balance: s.balance }),
          });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to apply balance");
      } else {
        setError(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const trend: SparkPoint[] = data.snapshots.map((s) => ({
    label: s.date.slice(5),
    value: s.total,
  }));

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-baseline justify-between">
            Net worth
            <span className="text-xs font-normal text-muted-foreground">
              Past {Math.max(trend.length, 1)} day{trend.length === 1 ? "" : "s"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-4xl font-semibold tracking-tight">
            {usd(data.now.total)}
            {data.weeklyDelta != null && (
              <span
                className={cn(
                  "ml-3 text-base font-medium",
                  data.weeklyDelta >= 0
                    ? "text-emerald-600 dark:text-emerald-500"
                    : "text-destructive"
                )}
              >
                {data.weeklyDelta >= 0 ? "▲" : "▼"} {usd(Math.abs(data.weeklyDelta))} this week
              </span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {usd(data.now.accountsTotal)} in accounts · {usd(data.now.holdingsValue)} in
            holdings
            {data.now.holdingsPriced === "cost-basis" &&
              " (at cost basis — quotes not loaded)"}
          </p>
          {trend.length > 1 && <Sparkline data={trend} height={72} formatValue={usd} />}
        </CardContent>
      </Card>

      {data.balanceSuggestions?.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>From your statements</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              Balances read from imported statements. Account balances are entered
              by hand, so apply these to keep net worth current — nothing is written
              until you confirm.
            </p>
            {data.balanceSuggestions.map((s) => (
              <div
                key={s.label}
                className="flex flex-wrap items-center justify-between gap-2 rounded border p-2"
              >
                <span>
                  <span className="font-medium">{s.label}</span>{" "}
                  {s.month ? `(${s.month})` : ""} shows a{" "}
                  {s.kind === "debt" ? "balance owed" : "balance"} of{" "}
                  <span className="font-semibold tabular-nums">{usd(s.balance)}</span>
                  {s.currentBalance != null ? (
                    <span className="text-muted-foreground">
                      {" "}
                      — account currently {usd(s.currentBalance)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground"> — no matching account yet</span>
                  )}
                </span>
                <Button size="sm" disabled={busy} onClick={() => applySuggestion(s)}>
                  {s.accountId ? "Update" : "Create account"}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {data.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No manual accounts yet — add cash, savings, and debts below. Holdings from
              the Stocks tab are included automatically.
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {data.accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="w-40 font-medium">{a.name}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs capitalize",
                      a.kind === "debt"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {a.kind}
                  </span>
                  <form
                    className="ml-auto flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveBalance(a);
                    }}
                  >
                    <Input
                      type="number"
                      step="any"
                      min={0}
                      value={edits[a.id] ?? String(a.balance)}
                      onChange={(e) =>
                        setEdits((m) => ({ ...m, [a.id]: e.target.value }))
                      }
                      className="h-8 w-32 text-right text-sm"
                      aria-label={`${a.name} balance`}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      disabled={
                        busy ||
                        edits[a.id] == null ||
                        edits[a.id] === "" ||
                        Number(edits[a.id]) === a.balance
                      }
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => remove(a)}
                    >
                      ✕
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="nw-name" className="text-xs">
                Account name
              </Label>
              <Input
                id="nw-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Chase checking"
                className="w-48"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger className="w-32 capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k} className="capitalize">
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="nw-balance" className="text-xs">
                Balance
              </Label>
              <Input
                id="nw-balance"
                type="number"
                step="any"
                min={0}
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                className="w-32"
              />
            </div>
            <Button type="submit" disabled={busy || !name.trim() || balance === ""}>
              Add account
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            Debt balances are entered as positive numbers and subtracted from the total.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
