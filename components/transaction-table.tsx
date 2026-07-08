"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type Why = { source: "keyword"; keyword: string } | { source: "model" };
type Txn = {
  id: number;
  date: string;
  amount: number;
  merchant: string;
  category: string;
  raw_description: string;
  is_recurring: number;
  why: Why;
};

type SortKey = "date" | "amount" | "category";
type SortState = { key: SortKey; dir: "asc" | "desc" };

const usd = (v: number) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function whyText(why: Why): string {
  return why.source === "keyword"
    ? `matched keyword "${why.keyword}"`
    : "assigned by the model";
}

// Sortable, searchable transaction table with per-row "why" (B3) and inline
// re-categorize (B4). `categoryFilter` is controlled by the parent so a
// category chip or a spend-chart bar click filters this table in place.
export function TransactionTable({
  month,
  categoryFilter,
  onClearFilter,
  onChanged,
}: {
  month: string | null;
  categoryFilter: string | null;
  onClearFilter: () => void;
  onChanged: () => void;
}) {
  const [txns, setTxns] = useState<Txn[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "date", dir: "desc" });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [applyFuture, setApplyFuture] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    const res = await fetch(`/api/finance/transactions${month ? `?month=${month}` : ""}`);
    if (!res.ok) return;
    const data = await res.json();
    setTxns(data.transactions);
    setCategories(data.categories);
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  async function recategorize(id: number, category: string) {
    await fetch("/api/finance/transactions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, category, applyToFuture: !!applyFuture[id] }),
    });
    await load();
    onChanged(); // refresh the parent's totals/charts
  }

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }
    );
  }
  const caret = (key: SortKey) => (sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");

  const q = search.trim().toLowerCase();
  const filtered = txns
    .filter((t) => !categoryFilter || t.category === categoryFilter)
    .filter(
      (t) =>
        !q ||
        t.raw_description.toLowerCase().includes(q) ||
        t.merchant.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
    )
    .sort((a, b) => {
      let cmp: number;
      if (sort.key === "amount") cmp = a.amount - b.amount;
      else if (sort.key === "category") cmp = a.category.localeCompare(b.category);
      else cmp = a.date.localeCompare(b.date);
      return sort.dir === "asc" ? cmp : -cmp;
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search merchant, description, category…"
          className="max-w-xs"
        />
        {categoryFilter && (
          <Badge variant="secondary" className="gap-1">
            {categoryFilter}
            <button className="ml-1" onClick={onClearFilter} aria-label="Clear filter">
              ✕
            </button>
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{filtered.length} shown</span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No transactions match.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <button className="hover:underline" onClick={() => toggleSort("date")}>
                  Date{caret("date")}
                </button>
              </TableHead>
              <TableHead>Merchant</TableHead>
              <TableHead>
                <button className="hover:underline" onClick={() => toggleSort("category")}>
                  Category{caret("category")}
                </button>
              </TableHead>
              <TableHead className="text-right">
                <button className="hover:underline" onClick={() => toggleSort("amount")}>
                  Amount{caret("amount")}
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((t) => (
              <Fragment key={t.id}>
                <TableRow
                  className="cursor-pointer"
                  onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                >
                  <TableCell className="tabular-nums">{t.date}</TableCell>
                  <TableCell>
                    {t.merchant}
                    {t.is_recurring === 1 && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        recurring
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{t.category}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(t.amount)}</TableCell>
                </TableRow>
                {expanded === t.id && (
                  <TableRow className="bg-muted/40">
                    <TableCell colSpan={4}>
                      <div className="flex flex-col gap-2 py-1 text-sm">
                        <span className="text-muted-foreground">{t.raw_description}</span>
                        <span className="text-xs text-muted-foreground">
                          Categorized as <span className="font-medium">{t.category}</span> —{" "}
                          {whyText(t.why)}.
                        </span>
                        <div
                          className="flex flex-wrap items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="text-xs">Re-categorize:</span>
                          <Select value={t.category} onValueChange={(v) => void recategorize(t.id, v)}>
                            <SelectTrigger className="h-8 w-44">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {categories.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {c}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <label className="flex items-center gap-1 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={!!applyFuture[t.id]}
                              onChange={(e) =>
                                setApplyFuture((m) => ({ ...m, [t.id]: e.target.checked }))
                              }
                            />
                            apply to future &quot;{t.merchant}&quot;
                          </label>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
