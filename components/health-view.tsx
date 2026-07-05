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

type Row = { date: string; kind: string; value: number; notes: string | null };

const KIND_META: Record<string, { label: string; unit: string; hint: string }> = {
  sleep_hours: { label: "Sleep", unit: "hours", hint: "e.g. 7.5" },
  bedtime: { label: "Bedtime", unit: "hour of day", hint: "e.g. 23.5 = 11:30pm" },
  weight: { label: "Weight", unit: "", hint: "your usual unit" },
  mood: { label: "Mood", unit: "/ 5", hint: "1–5" },
};

export function HealthView() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("sleep_hours");
  const [value, setValue] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/health?days=60");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setRows(data.rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (value === "") return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { kind, value: Number(value) };
      if (date) body.date = date;
      const res = await fetch("/api/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to log");
      } else {
        setValue("");
        setDate("");
        setError(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const series = (k: string): SparkPoint[] =>
    rows.filter((r) => r.kind === k).map((r) => ({ label: r.date.slice(5), value: r.value }));

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Log a metric</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Metric</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(KIND_META).map(([k, meta]) => (
                    <SelectItem key={k} value={k}>
                      {meta.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="hv" className="text-xs">
                Value ({KIND_META[kind].hint})
              </Label>
              <Input
                id="hv"
                type="number"
                step="any"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-32"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="hd" className="text-xs">
                Date (blank = today)
              </Label>
              <Input
                id="hd"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-40"
              />
            </div>
            <Button type="submit" disabled={busy || value === ""}>
              Log
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Object.entries(KIND_META).map(([k, meta]) => {
          const data = series(k);
          const latest = data[data.length - 1];
          return (
            <Card key={k}>
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between">
                  {meta.label}
                  <span className="text-xs font-normal text-muted-foreground">
                    Past 60 days
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {data.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No entries yet.</p>
                ) : (
                  <>
                    <p className="text-3xl font-semibold tracking-tight">
                      {latest.value}
                      <span className="ml-1 text-sm font-normal text-muted-foreground lowercase">
                        {meta.unit} · {latest.label}
                      </span>
                    </p>
                    {data.length > 1 && <Sparkline data={data} height={56} />}
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
