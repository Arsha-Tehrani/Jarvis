"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RingGauge } from "@/components/ring-gauge";
import { Badge } from "@/components/ui/badge";
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

type Progress = {
  key: string;
  goalId: number | null;
  kind: string;
  label: string;
  target: number;
  actual: number;
  unit: string;
  fraction: number;
  onTrack: boolean;
  displayActual: string;
  href: string;
};

const GOAL_LABELS: Record<string, string> = {
  savings_rate: "Savings rate (% of income)",
  gym_days_per_week: "Gym days per week",
  leetcode_per_week: "LeetCode problems per week",
  sleep_hours: "Average sleep (hours/night)",
};

// Percent-style goals read better as bars; count goals as rings.
const BAR_KINDS = new Set(["savings_rate", "sleep_hours"]);

export function GoalsView() {
  const [progress, setProgress] = useState<Progress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("savings_rate");
  const [target, setTarget] = useState("");
  const [edits, setEdits] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/goals");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load goals");
      setProgress(data.progress);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load goals");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveGoal(goalKind: string, value: number) {
    if (!(value > 0)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/finance/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: goalKind, target: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to save goal");
      } else {
        setError(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeGoal(goalId: number) {
    await fetch(`/api/finance/goals?id=${goalId}`, { method: "DELETE" });
    await load();
  }

  const onTrackCount = progress.filter((p) => p.onTrack).length;
  const unsetKinds = Object.keys(GOAL_LABELS).filter(
    (k) => !progress.some((p) => p.kind === k)
  );

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {progress.length > 0 && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {onTrackCount} of {progress.length}
          </span>{" "}
          goals on track this period.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {progress.map((p) => (
          <Card key={p.key}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-sm">
                <Link href={p.href} className="hover:underline">
                  {p.label}
                </Link>
                <Badge variant={p.onTrack ? "secondary" : "outline"}>
                  {p.onTrack ? "on track" : "behind"}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              {BAR_KINDS.has(p.kind) ? (
                <div className="flex-1">
                  <p className="text-2xl font-semibold tracking-tight">
                    {p.displayActual}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      / {p.target}
                      {p.unit === "%" ? "%" : ` ${p.unit}`}
                    </span>
                  </p>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        p.onTrack ? "bg-primary" : "bg-primary/50"
                      )}
                      style={{ width: `${p.fraction * 100}%` }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <RingGauge value={Math.round(p.actual)} target={p.target} />
                  <p className="text-sm text-muted-foreground">
                    {p.displayActual} of {p.target} {p.unit}
                  </p>
                </>
              )}
              {p.goalId != null && (
                <form
                  className="ml-auto flex flex-col items-end gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const raw = edits[p.goalId as number];
                    if (raw) void saveGoal(p.kind, Number(raw));
                  }}
                >
                  <Input
                    type="number"
                    step="any"
                    min={0}
                    placeholder={String(p.target)}
                    value={edits[p.goalId] ?? ""}
                    onChange={(e) =>
                      setEdits((m) => ({ ...m, [p.goalId as number]: e.target.value }))
                    }
                    className="h-8 w-20 text-right text-sm"
                    aria-label={`New target for ${p.label}`}
                  />
                  <span className="flex gap-1">
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      disabled={busy || !(Number(edits[p.goalId]) > 0)}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeGoal(p.goalId as number)}
                    >
                      ✕
                    </Button>
                  </span>
                </form>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {progress.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No goals yet — set one below. Habit goals appear automatically from the Habits
          tab.
        </p>
      )}

      {unsetKinds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Set a goal</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveGoal(kind, Number(target)).then(() => setTarget(""));
              }}
            >
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Goal</Label>
                <Select
                  value={unsetKinds.includes(kind) ? kind : unsetKinds[0]}
                  onValueChange={setKind}
                >
                  <SelectTrigger className="w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {unsetKinds.map((k) => (
                      <SelectItem key={k} value={k}>
                        {GOAL_LABELS[k]}
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
                  step="any"
                  min={0}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="w-28"
                />
              </div>
              <Button type="submit" disabled={busy || !(Number(target) > 0)}>
                Save goal
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
