"use client";

import { useCallback, useEffect, useState } from "react";
import { Keyboard, Mic, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// Every agent turn, newest first — what you said, what the model asked for,
// what actually ran, and why it failed if it did. Same table/filter language
// as /network-log. Auto-refreshes so you can say something to Jarvis and watch
// it land here.

type AgentLogRow = {
  id: number;
  created_at: string;
  input_source: string | null;
  user_text: string;
  requested_calls: string | null;
  executed_calls: string | null;
  status: string | null;
  error_message: string | null;
  provider: string | null;
  model: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
};

const STATUS_OPTIONS = [
  "ok",
  "validation_error",
  "execution_error",
  "llm_error",
  "pending_confirmation",
] as const;

const STATUS_LABEL: Record<string, string> = {
  ok: "ok",
  validation_error: "validation error",
  execution_error: "execution error",
  llm_error: "llm error",
  pending_confirmation: "pending confirmation",
};

function statusChipClass(status: string | null): string {
  switch (status) {
    case "ok":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "validation_error":
      return "bg-warn-bg text-warn";
    case "execution_error":
    case "llm_error":
      return "bg-destructive/15 text-destructive";
    case "pending_confirmation":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
}

const REFRESH_MS = 5000;

function prettyJson(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw; // show as-is if it isn't valid JSON
  }
}

export function AgentLogView() {
  const [rows, setRows] = useState<AgentLogRow[] | null>(null);
  const [status, setStatus] = useState("");
  const [since, setSince] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (since) params.set("since", since);
      if (q) params.set("q", q);
      const res = await fetch(`/api/agent-log?${params}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { rows: AgentLogRow[] };
      setRows(data.rows);
      setError(false);
    } catch {
      setError(true);
    }
  }, [status, since, q]);

  // Load on filter change, and poll while open (this is a debugging tool).
  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasFilters = Boolean(status || since || q);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Agent log</h1>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          Every turn you&apos;ve asked Jarvis, newest first — the input, the tool calls the model
          requested, what actually ran, and the error detail when something failed. Refreshes
          automatically. Kept indefinitely (it powers conversation memory and undo).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
        >
          <option value="">all statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          aria-label="Filter from date"
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
        />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search input / error"
          aria-label="Search input and error text"
          className="h-8 w-48 rounded-md border border-input bg-transparent px-2 text-xs"
        />
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setStatus("");
              setSince("");
              setQ("");
            }}
            className="action-link text-xs"
          >
            clear filters
          </button>
        )}
      </div>

      <Card className="px-(--card-spacing)">
        {error && <p className="py-4 text-xs text-muted-foreground">log unavailable</p>}
        {!error && rows && rows.length === 0 && (
          <p className="py-4 text-xs text-muted-foreground">
            No agent activity yet{hasFilters ? " for this filter" : ""}.
          </p>
        )}
        {!error && rows && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6" />
                <TableHead>When</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Input</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <RowItem
                  key={row.id}
                  row={row}
                  open={expanded.has(row.id)}
                  onToggle={() => toggle(row.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function SourceIcon({ source }: { source: string | null }) {
  if (source === "voice_mic" || source === "voice_ptt") {
    return <Mic className="size-3.5 text-muted-foreground" aria-label="voice" />;
  }
  if (source === "typed") {
    return <Keyboard className="size-3.5 text-muted-foreground" aria-label="typed" />;
  }
  return <span className="text-muted-foreground">—</span>;
}

function RowItem({
  row,
  open,
  onToggle,
}: {
  row: AgentLogRow;
  open: boolean;
  onToggle: () => void;
}) {
  const requested = prettyJson(row.requested_calls);
  const executed = prettyJson(row.executed_calls);
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="align-top">
          <ChevronRight
            className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        </TableCell>
        <TableCell className="text-xs whitespace-nowrap text-muted-foreground align-top">
          {new Date(row.created_at).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </TableCell>
        <TableCell className="align-top">
          <SourceIcon source={row.input_source} />
        </TableCell>
        <TableCell className="max-w-md truncate text-xs align-top" title={row.user_text}>
          {row.user_text}
        </TableCell>
        <TableCell className="align-top">
          <span
            className={cn(
              "inline-block rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
              statusChipClass(row.status)
            )}
          >
            {row.status ? (STATUS_LABEL[row.status] ?? row.status) : "legacy"}
          </span>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground align-top">{row.model ?? "—"}</TableCell>
        <TableCell className="text-right text-xs text-muted-foreground align-top">
          {row.latency_ms != null ? `${row.latency_ms}ms` : "—"}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/30">
            <div className="flex flex-col gap-3 py-2 text-xs">
              <Detail label="Input">
                <p className="whitespace-pre-wrap">{row.user_text}</p>
              </Detail>
              {row.error_message && (
                <Detail label="Error">
                  <pre className="whitespace-pre-wrap text-destructive">{row.error_message}</pre>
                </Detail>
              )}
              {requested && (
                <Detail label="Requested calls (before validation)">
                  <pre className="overflow-x-auto rounded bg-background p-2 font-mono">{requested}</pre>
                </Detail>
              )}
              {executed && (
                <Detail label="Executed calls">
                  <pre className="overflow-x-auto rounded bg-background p-2 font-mono">{executed}</pre>
                </Detail>
              )}
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
                <span>provider: {row.provider ?? "—"}</span>
                <span>model: {row.model ?? "—"}</span>
                <span>latency: {row.latency_ms != null ? `${row.latency_ms}ms` : "—"}</span>
                <span>
                  tokens: {row.input_tokens ?? "—"} in / {row.output_tokens ?? "—"} out
                </span>
                <span>cost: {row.cost_usd != null ? `$${row.cost_usd.toFixed(4)}` : "—"}</span>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
