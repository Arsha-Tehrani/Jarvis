"use client";

import { useEffect, useState } from "react";
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

// The privacy audit table: every outbound network call Jarvis has made,
// host + purpose only. Filterable by feature and day.

type NetworkLogRow = {
  id: number;
  timestamp: string;
  feature: string;
  host: string;
  purpose: string;
  outcome: "ok" | "error";
  status_code: number | null;
  latency_ms: number;
};

export function NetworkLogView() {
  const [rows, setRows] = useState<NetworkLogRow[] | null>(null);
  const [features, setFeatures] = useState<string[]>([]);
  const [feature, setFeature] = useState("");
  const [day, setDay] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const params = new URLSearchParams();
        if (feature) params.set("feature", feature);
        if (day) params.set("day", day);
        const res = await fetch(`/api/network-log?${params}`);
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { rows: NetworkLogRow[]; features: string[] };
        if (!cancelled) {
          setRows(data.rows);
          setFeatures(data.features);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [feature, day]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Network log</h1>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          This is every outbound network call Jarvis has made — destination host and
          purpose only. Request contents, URLs, and headers are never logged. Calls to
          localhost (Ollama, sidecars, ActivityWatch) don&apos;t leave the machine and
          aren&apos;t listed. Entries are kept for 30 days.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={feature}
          onChange={(e) => setFeature(e.target.value)}
          aria-label="Filter by feature"
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
        >
          <option value="">all features</option>
          {features.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          aria-label="Filter by day"
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
        />
        {(feature || day) && (
          <button
            type="button"
            onClick={() => {
              setFeature("");
              setDay("");
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
            No outbound calls logged{feature || day ? " for this filter" : " yet"} — that&apos;s
            the goal state for an unconfigured install.
          </p>
        )}
        {!error && rows && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Feature</TableHead>
                <TableHead>Host</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {new Date(row.timestamp).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </TableCell>
                  <TableCell className="text-xs">{row.feature}</TableCell>
                  <TableCell className="text-xs font-mono">{row.host}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.purpose}</TableCell>
                  <TableCell
                    className={cn(
                      "text-xs",
                      row.outcome === "error" && "text-destructive"
                    )}
                  >
                    {row.outcome}
                    {row.status_code != null && ` (${row.status_code})`}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {row.latency_ms}ms
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
