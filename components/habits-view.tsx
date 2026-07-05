"use client";

import { useCallback, useEffect, useState } from "react";
import { ContributionHeatmap } from "@/components/heatmap";
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

type Habit = {
  id: number;
  name: string;
  cadence: "daily" | "weekly";
  goal: number;
  dates: string[];
  doneToday: boolean;
  streak: number;
  thisWeek: number;
};

export function HabitsView() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const [goal, setGoal] = useState("1");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/habits");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load habits");
      setHabits(data.habits);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load habits");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
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
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to create habit");
      } else {
        setName("");
        setGoal("1");
        setCadence("daily");
        setError(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(habit: Habit) {
    setBusy(true);
    try {
      await fetch("/api/habits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: habit.doneToday ? "unlog" : "log",
          habitId: habit.id,
        }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(habit: Habit) {
    if (!window.confirm(`Delete habit "${habit.name}" and its history?`)) return;
    await fetch(`/api/habits?id=${habit.id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>New habit</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="hb-name" className="text-xs">
                Name
              </Label>
              <Input
                id="hb-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
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
            <div className="flex flex-col gap-1">
              <Label htmlFor="hb-goal" className="text-xs">
                Goal / week
              </Label>
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
            <Button type="submit" disabled={busy || !name.trim()}>
              Add habit
            </Button>
          </form>
        </CardContent>
      </Card>

      {habits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No habits yet — add one above, then log it daily here or by telling Jarvis.
        </p>
      ) : (
        habits.map((habit) => (
          <Card key={habit.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                <span>{habit.name}</span>
                <span className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={habit.doneToday ? "outline" : "default"}
                    onClick={() => toggle(habit)}
                    disabled={busy}
                  >
                    {habit.doneToday ? "Done today ✓ (undo)" : "Done today"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(habit)}>
                    ✕
                  </Button>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                {habit.cadence === "daily" ? (
                  <>
                    <span className="font-medium text-foreground">{habit.streak}</span>-day
                    streak
                  </>
                ) : (
                  <>
                    <span className="font-medium text-foreground">
                      {habit.thisWeek}/{habit.goal}
                    </span>{" "}
                    this week
                  </>
                )}{" "}
                · {habit.dates.length} in the last year
              </p>
              <ContributionHeatmap loggedDates={habit.dates} />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
