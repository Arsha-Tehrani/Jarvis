"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SpendChart } from "@/components/spend-chart";
import { TransactionTable } from "@/components/transaction-table";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import type {
  CategorySpend,
  CutbackSuggestion,
  Goal,
  MonthSummary,
  RecurringCharge,
} from "@/lib/finance/analyze";
import type { RadarItem } from "@/lib/finance/radar";

type Statement = { id: number; month: string | null; file_path: string; imported_at: string };
type ImportResult = {
  file: string;
  status: "imported" | "warning" | "rejected";
  imported: number;
  kind?: "transaction" | "brokerage" | "unknown";
  categorizedBy?: string;
  warnings?: string[];
  reason?: string;
  llmError?: string;
  confidence?: number;
  signals?: string[];
};

type MonthComparison = { current: MonthSummary; comparison: MonthSummary | null };

type FinanceData = {
  statementsDir: string;
  statements: Statement[];
  transactionCount: number;
  periods: string[];
  currentPeriod: string | null;
  comparisonPeriod: string | null;
  spendByCategory: CategorySpend[];
  recurring: RecurringCharge[];
  radar: RadarItem[];
  summaries: MonthComparison;
  goals: Goal[];
  cutbacks: CutbackSuggestion[];
  categoryReference: Array<{ category: string; keywords: string[] }>;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "2026-06" → "June 2026". Mirrors lib/finance/period.monthLabel for the UI.
function monthLabel(period: string | null): string {
  if (!period) return "—";
  const [y, m] = period.split("-").map(Number);
  return MONTH_NAMES[m - 1] ? `${MONTH_NAMES[m - 1]} ${y}` : period;
}

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const GOAL_LABELS: Record<string, string> = {
  savings_rate: "Savings rate (% of income)",
  gym_days_per_week: "Gym days per week",
  leetcode_per_week: "LeetCode problems per week",
  sleep_hours: "Average sleep (hours/night)",
};

export function FinanceView() {
  const [data, setData] = useState<FinanceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importResults, setImportResults] = useState<ImportResult[] | null>(null);
  const [goalKind, setGoalKind] = useState("savings_rate");
  const [goalTarget, setGoalTarget] = useState("");
  const [selectedRenewals, setSelectedRenewals] = useState<Set<string>>(new Set());
  const [renewalResult, setRenewalResult] = useState<string | null>(null);
  // null = show the derived latest period; a YYYY-MM = the month paged to.
  const [month, setMonth] = useState<string | null>(null);
  // Category filter shared by the chips, the spend chart, and the txn table.
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const load = useCallback(async (ym: string | null) => {
    try {
      const res = await fetch(`/api/finance${ym ? `?month=${ym}` : ""}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load finance data");
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load finance data");
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [load, month]);

  async function runImport() {
    setBusy(true);
    setImportResults(null);
    try {
      const res = await fetch("/api/finance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import" }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Import failed");
      else setImportResults(body.results);
      await load(month);
    } finally {
      setBusy(false);
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Native file picker → POST /api/finance/upload → files land in
  // /statements and the same ingest pipeline runs immediately.
  async function uploadStatements(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    setError(null);
    setImportResults(null);
    try {
      const form = new FormData();
      for (const file of Array.from(list)) form.append("files", file);
      const res = await fetch("/api/finance/upload", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok && !body.saved?.length) {
        setError(
          body.error ??
            body.rejected?.map((r: { name: string; reason: string }) => `${r.name}: ${r.reason}`).join("; ") ??
            "Upload failed"
        );
      }
      const rejectedLines: ImportResult[] = (body.rejected ?? []).map(
        (r: { name: string; reason: string }) => ({
          file: r.name,
          status: "rejected" as const,
          imported: 0,
          reason: r.reason,
        })
      );
      if (body.results || rejectedLines.length) {
        setImportResults([...(body.results ?? []), ...rejectedLines]);
      }
      await load(month);
    } catch {
      setError("Could not reach the API.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function saveGoal(e: React.FormEvent) {
    e.preventDefault();
    const target = Number(goalTarget);
    if (!(target > 0)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/finance/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: goalKind, target }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to save goal");
      } else {
        setGoalTarget("");
      }
      await load(month);
    } finally {
      setBusy(false);
    }
  }

  async function deleteGoal(id: number) {
    await fetch(`/api/finance/goals?id=${id}`, { method: "DELETE" });
    await load(month);
  }

  function toggleRenewal(merchant: string) {
    setSelectedRenewals((prev) => {
      const next = new Set(prev);
      if (next.has(merchant)) next.delete(merchant);
      else next.add(merchant);
      return next;
    });
  }

  // Confirm leg: only the user's explicit click creates calendar events.
  async function createRenewalEvents() {
    if (!data) return;
    const chosen = data.radar.filter((r) => selectedRenewals.has(r.merchant));
    if (chosen.length === 0) return;
    setBusy(true);
    setRenewalResult(null);
    try {
      const res = await fetch("/api/finance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_renewal_events",
          events: chosen.map((r) => ({
            title: `Renewal: ${r.merchant} (~${usd(r.usualAmount)})`,
            start: `${r.nextRenewal}T09:00:00`,
          })),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setRenewalResult(body.error ?? "Failed to create events");
      } else {
        setRenewalResult(
          [...(body.created ?? []), ...(body.failed ?? [])].join(" ") || "Done."
        );
        setSelectedRenewals(new Set());
      }
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const current = data.summaries.current;
  const last = data.summaries.comparison;
  const periods = data.periods ?? [];
  const shownIdx = data.currentPeriod ? periods.indexOf(data.currentPeriod) : -1;
  const canPrev = shownIdx > 0;
  const canNext = shownIdx >= 0 && shownIdx < periods.length - 1;

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Statements</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Drop bank statements (CSV/PDF) or Fidelity brokerage exports (Positions or
            Accounts-history CSV) into{" "}
            <code className="rounded bg-muted px-1">{data.statementsDir}</code>, then
            import. Statements become transactions; brokerage files update holdings on
            the Stocks tab. Account numbers are never stored; nothing leaves this
            machine.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.pdf"
              multiple
              className="hidden"
              onChange={(e) => void uploadStatements(e.target.files)}
            />
            <Button onClick={() => fileInputRef.current?.click()} disabled={busy}>
              {busy ? "Working…" : "Import new statement…"}
            </Button>
            <Button variant="outline" onClick={runImport} disabled={busy}>
              Scan folder
            </Button>
            <span className="text-muted-foreground">
              {data.statements.length} imported · {data.transactionCount} transactions
            </span>
          </div>
          {importResults && (
            <ul className="flex flex-col gap-1">
              {importResults.length === 0 && (
                <li className="text-muted-foreground">No new files found.</li>
              )}
              {importResults.map((r, i) => (
                <li
                  key={i}
                  className={
                    r.status === "rejected"
                      ? "text-destructive"
                      : r.status === "warning"
                        ? "text-amber-600 dark:text-amber-500"
                        : ""
                  }
                >
                  <span className="font-medium">{r.file}</span>:{" "}
                  {r.status === "rejected" ? (
                    <>Rejected — {r.reason}</>
                  ) : (
                    <>
                      {r.imported}{" "}
                      {r.kind === "brokerage" ? "holdings" : "transactions"}
                      {r.categorizedBy ? ` (${r.categorizedBy})` : ""}
                      {r.status === "warning" ? " — parsed with warnings" : ""}
                    </>
                  )}
                  {r.warnings?.length ? (
                    <ul className="ml-4 list-disc text-muted-foreground">
                      {r.warnings.map((w, j) => (
                        <li key={j}>{w}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {data.statements.length > 0 && (
            <ul className="text-muted-foreground">
              {data.statements.map((s) => (
                <li key={s.id}>
                  {s.file_path} — {s.month ?? "?"} (imported {s.imported_at.slice(0, 10)})
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>{monthLabel(data.currentPeriod)}</CardTitle>
            {/* Statement-based, so navigate real months with data — no live
                "current month". Paging is disabled past the imported range. */}
            <div className="flex items-center gap-2 text-sm">
              <Button
                variant="outline"
                size="sm"
                disabled={!canPrev}
                onClick={() => setMonth(periods[shownIdx - 1])}
              >
                ← Prev
              </Button>
              <Select
                value={data.currentPeriod ?? undefined}
                onValueChange={(v) => setMonth(v)}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Month" />
                </SelectTrigger>
                <SelectContent>
                  {[...periods].reverse().map((p) => (
                    <SelectItem key={p} value={p}>
                      {monthLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={!canNext}
                onClick={() => setMonth(periods[shownIdx + 1])}
              >
                Next →
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Statement-based — figures cover the month shown, not a live current month.
          </p>
        </CardHeader>
        <CardContent>
          {current.month === "" ? (
            <p className="text-sm text-muted-foreground">
              No transactions imported yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-8 text-sm">
              {(
                [
                  ["Income", current.income, last?.income],
                  ["Spend", current.spend, last?.spend],
                  ["Invested", current.invested, last?.invested],
                  ["Net", current.net, last?.net],
                ] as const
              ).map(([label, value, prev]) => (
                <div key={label}>
                  <p className="text-2xl font-semibold tabular-nums">{usd(value)}</p>
                  <p className="text-muted-foreground">
                    {label}
                    {last
                      ? ` · ${usd(prev ?? 0)} in ${monthLabel(data.comparisonPeriod)}`
                      : " · not enough history yet"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How categories work</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {/* Generated from the real keyword-fallback rules in categorize.ts —
              never a separate copy that can drift. */}
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              Every transaction is sorted into one of these 15 categories (LLM first,
              these keyword rules as the always-working fallback). Click to see them.
            </summary>
            <ul className="mt-3 flex flex-col gap-2">
              {(data.categoryReference ?? []).map((c) => (
                <li key={c.category} className="flex flex-col gap-1">
                  <span className="font-medium">{c.category}</span>
                  <span className="text-muted-foreground">
                    {c.keywords.length > 0
                      ? `matches: ${c.keywords.slice(0, 8).join(", ")}${c.keywords.length > 8 ? "…" : ""}`
                      : c.category === "Other"
                        ? "anything the rules don't match (and the LLM didn't classify)"
                        : "assigned by the model or by amount (positive = Income)"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Spend by category</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {data.spendByCategory.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No spending data yet — import a statement.
            </p>
          ) : (
            <>
              {/* Clickable chips filter the transaction table below in place. */}
              <div className="flex flex-wrap gap-2">
                {data.spendByCategory.map((c) => (
                  <button
                    key={c.category}
                    onClick={() =>
                      setCategoryFilter(categoryFilter === c.category ? null : c.category)
                    }
                  >
                    <Badge variant={categoryFilter === c.category ? "default" : "secondary"}>
                      {c.category} {usd(c.thisMonth)}
                    </Badge>
                  </button>
                ))}
              </div>
              {/* Clicking a bar applies that category filter. */}
              <SpendChart data={data.spendByCategory} onSelect={setCategoryFilter} />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">{monthLabel(data.currentPeriod)}</TableHead>
                    <TableHead className="text-right">Prior month</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.spendByCategory.map((c) => (
                    <TableRow
                      key={c.category}
                      className="cursor-pointer"
                      onClick={() =>
                        setCategoryFilter(categoryFilter === c.category ? null : c.category)
                      }
                    >
                      <TableCell>{c.category}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {usd(c.thisMonth)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {usd(c.lastMonth)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.lastMonth === 0 && c.thisMonth === 0
                          ? "—"
                          : `${c.thisMonth >= c.lastMonth ? "+" : "−"}${usd(Math.abs(c.thisMonth - c.lastMonth))}`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transactions — {monthLabel(data.currentPeriod)}</CardTitle>
        </CardHeader>
        <CardContent>
          <TransactionTable
            month={data.currentPeriod}
            categoryFilter={categoryFilter}
            onClearFilter={() => setCategoryFilter(null)}
            onChanged={() => void load(month)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recurring charges</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recurring.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recurring charges detected yet (needs at least two similar monthly
              charges from the same merchant).
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Merchant</TableHead>
                    <TableHead className="text-right">~Monthly</TableHead>
                    <TableHead className="text-right">Seen</TableHead>
                    <TableHead className="text-right">Last charge</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recurring.map((r) => (
                    <TableRow key={r.merchant}>
                      <TableCell>{r.merchant}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {usd(r.monthlyCost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.occurrences}×
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.lastDate}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-sm text-muted-foreground">
                Total ≈{" "}
                {usd(data.recurring.reduce((sum, r) => sum + r.monthlyCost, 0))}/month
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {data.radar.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Bill radar</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <ul className="flex flex-col divide-y">
              {data.radar.map((r) => (
                <li key={r.merchant} className="flex flex-wrap items-center gap-2 py-2">
                  <Checkbox
                    checked={selectedRenewals.has(r.merchant)}
                    onCheckedChange={() => toggleRenewal(r.merchant)}
                    aria-label={`Select ${r.merchant} renewal`}
                  />
                  <span className="font-medium">{r.merchant}</span>
                  <span className="text-muted-foreground">
                    ~{usd(r.usualAmount)} every ~{r.medianGapDays}d
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    {r.jumpPercent != null && (
                      <Badge variant="destructive">+{r.jumpPercent}% jump</Badge>
                    )}
                    {r.renewsSoon && (
                      <Badge variant="secondary">
                        {r.daysUntil <= 0
                          ? "renews about now"
                          : `renews in ~${r.daysUntil}d`}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      next ≈ {r.nextRenewal}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3">
              <Button
                onClick={createRenewalEvents}
                disabled={busy || selectedRenewals.size === 0}
                variant="outline"
              >
                Add {selectedRenewals.size || ""} selected renewal
                {selectedRenewals.size === 1 ? "" : "s"} to calendar
              </Button>
              <span className="text-xs text-muted-foreground">
                Nothing is created until you click — bulk calendar writes are
                confirm-gated.
              </span>
            </div>
            {renewalResult && (
              <p className="whitespace-pre-wrap text-muted-foreground">{renewalResult}</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Goals & cut-backs</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          {data.cutbacks.map((c, i) => (
            <div key={i} className="rounded-md border p-3">
              <p className="font-medium">{c.message}</p>
              {c.suggestions.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {c.suggestions.map((s) => (
                    <li key={s.category}>
                      Cut {usd(s.cutNeeded)} from {s.category} (spent {usd(s.spend)} this
                      month)
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {data.goals.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {data.goals.map((g) => (
                <li key={g.id} className="flex items-center gap-3">
                  <span className="flex-1">
                    {GOAL_LABELS[g.kind] ?? g.kind}:{" "}
                    <span className="font-medium">
                      {g.target}
                      {g.kind === "savings_rate" ? "%" : ""}
                    </span>{" "}
                    <span className="text-muted-foreground">per {g.period}</span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => deleteGoal(g.id)}>
                    ✕
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              No goals yet. Set a savings rate to get cut-back suggestions.
            </p>
          )}
          <form onSubmit={saveGoal} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Goal</Label>
              <Select value={goalKind} onValueChange={setGoalKind}>
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(GOAL_LABELS).map(([kind, label]) => (
                    <SelectItem key={kind} value={kind}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="goal-target" className="text-xs">
                Target
              </Label>
              <Input
                id="goal-target"
                type="number"
                min={1}
                step="any"
                value={goalTarget}
                onChange={(e) => setGoalTarget(e.target.value)}
                className="w-28"
              />
            </div>
            <Button type="submit" disabled={busy || !(Number(goalTarget) > 0)}>
              Save goal
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
