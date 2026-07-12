"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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

type Tracker = {
  id: number;
  name: string;
  cadence: "daily" | "weekly";
  source: string | null;
  target: number | null;
  goal: number;
  label: string;
  logCount: number;
};

type Suggestion = { id: number; name: string; score: number };

// Habits is a MANAGEMENT surface, not a second visualization: it lists what
// you track and lets you create new trackers (with a duplicate suggestion).
// The actual charts/streaks live on the Trackers page.
export function HabitsView() {
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const [goal, setGoal] = useState("1");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/habits");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load trackers");
      setTrackers(data.trackers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trackers");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(force: boolean) {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/habits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: name.trim(),
          cadence,
          goal: Number(goal) || 1,
          force,
        }),
      });
      const data = await res.json();
      // A likely duplicate → show the suggestion, don't create yet.
      if (res.ok && data.suggestion) {
        setSuggestion(data.suggestion);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "Failed to create tracker");
        return;
      }
      setName("");
      setGoal("1");
      setCadence("daily");
      setSuggestion(null);
      setError(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  // Manual vs sourced deletes are different things (lib/tracker-delete.ts):
  // the confirm copy must say which one is about to happen — what data is
  // lost for a manual habit, and what data survives for a sourced tracker.
  async function remove(t: Tracker) {
    const message = t.source
      ? `Remove the "${t.name}" tracker? Only its target/cadence config is deleted — the underlying ${t.source} data stays untouched, and a new tracker can point at it again later.`
      : `Delete "${t.name}" and its ${t.logCount} logged entr${t.logCount === 1 ? "y" : "ies"}? This can't be undone.`;
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/habits?id=${t.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to delete tracker");
      } else {
        setError(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const manual = trackers.filter((t) => !t.source);
  const sourced = trackers.filter((t) => t.source);

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>New tracker</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create(false);
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="hb-name" className="text-xs">Name</Label>
              <Input
                id="hb-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSuggestion(null);
                }}
                placeholder="Read 20 minutes"
                className="w-56"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Cadence</Label>
              <Select value={cadence} onValueChange={(v) => setCadence(v as typeof cadence)}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {cadence === "weekly" && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="hb-goal" className="text-xs">Target / week</Label>
                <Input
                  id="hb-goal"
                  type="number"
                  min={1}
                  max={100}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  className="w-24"
                />
              </div>
            )}
            <Button type="submit" disabled={busy || !name.trim()}>
              Add tracker
            </Button>
          </form>

          {suggestion && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-warn/40 bg-warn-bg p-2 text-sm">
              <span>
                This looks like it might be the same as{" "}
                <Link href="/trackers" className="font-medium underline">
                  {suggestion.name}
                </Link>{" "}
                — use that instead, or create a new one anyway?
              </span>
              <Button size="sm" variant="outline" onClick={() => setSuggestion(null)}>
                Use existing
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void create(true)}>
                Create anyway
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What you track</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">
            See streaks, heatmaps and progress rings on the{" "}
            <Link href="/trackers" className="underline">Trackers</Link> page.
          </p>
          {trackers.length === 0 ? (
            <p className="text-muted-foreground">Nothing tracked yet — add one above.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {[...sourced, ...manual].map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                  <Link href="/trackers" className="font-medium hover:underline">
                    {t.name}
                  </Link>
                  <Badge variant="outline">{t.cadence}</Badge>
                  {t.source && <Badge variant="secondary">linked: {t.source}</Badge>}
                  {t.target != null && (
                    <span className="text-muted-foreground">target {t.target}</span>
                  )}
                  {!t.source && t.cadence === "weekly" && (
                    <span className="text-muted-foreground">target {t.goal}/week</span>
                  )}
                  <span className="ml-auto text-muted-foreground">{t.label}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void remove(t)}
                    aria-label={`Delete tracker ${t.name}`}
                  >
                    ✕
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
