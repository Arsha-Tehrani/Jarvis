"use client";

import { useCallback, useEffect, useState } from "react";
import { ContributionHeatmap } from "@/components/heatmap";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type GymLog = { id: number; date: string; notes: string | null };
type NutritionEntry = {
  id: number;
  item: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  source: "photo" | "text";
};
type DayNutrition = {
  entries: NutritionEntry[];
  totals: { calories: number; protein: number; carbs: number; fat: number };
  calorieGoal: number | null;
};
type RecentProblem = { title: string; titleSlug: string; timestamp: string };
type LeetCodeLatest = {
  date: string;
  total_solved: number;
  streak: number;
  recent: RecentProblem[];
};

export function TrackersView() {
  const [gymLogs, setGymLogs] = useState<GymLog[]>([]);
  const [leetcode, setLeetcode] = useState<LeetCodeLatest | null>(null);
  const [nutrition, setNutrition] = useState<DayNutrition | null>(null);
  const [gymError, setGymError] = useState<string | null>(null);
  const [lcError, setLcError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualTotal, setManualTotal] = useState("");
  const [manualStreak, setManualStreak] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/gym");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGymLogs(data.logs);
      setGymError(null);
    } catch (err) {
      setGymError(err instanceof Error ? err.message : "Failed to load gym logs");
    }
    try {
      const res = await fetch("/api/leetcode");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setLeetcode(data.latest);
      setLcError(null);
    } catch (err) {
      setLcError(err instanceof Error ? err.message : "Failed to load LeetCode stats");
    }
    try {
      const res = await fetch("/api/nutrition");
      const data = await res.json();
      if (res.ok) setNutrition(data);
    } catch {
      // card just shows the empty state
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const today = new Date().toISOString().slice(0, 10);
  const wentToday = gymLogs.some((l) => l.date === today);

  async function logToday() {
    setBusy(true);
    try {
      if (wentToday) {
        await fetch(`/api/gym?date=${today}`, { method: "DELETE" });
      } else {
        await fetch("/api/gym", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function refreshLeetcode() {
    setBusy(true);
    setLcError(null);
    try {
      const res = await fetch("/api/leetcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      });
      const data = await res.json();
      if (!res.ok) setLcError(data.error ?? "Refresh failed");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const total = Number(manualTotal);
    if (!Number.isInteger(total) || total < 0) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { total_solved: total };
      if (manualStreak !== "") body.streak = Number(manualStreak);
      const res = await fetch("/api/leetcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) setLcError(data.error ?? "Manual entry failed");
      else {
        setManualTotal("");
        setManualStreak("");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const daysThisMonth = gymLogs.filter((l) => l.date.slice(0, 7) === today.slice(0, 7)).length;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Gym</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <Button onClick={logToday} disabled={busy} variant={wentToday ? "outline" : "default"}>
              {wentToday ? "Went today ✓ (undo)" : "I went today"}
            </Button>
            <span className="text-sm text-muted-foreground">
              {daysThisMonth} day{daysThisMonth === 1 ? "" : "s"} this month
            </span>
          </div>
          {gymError && <p className="text-sm text-destructive">{gymError}</p>}
          <ContributionHeatmap loggedDates={gymLogs.map((l) => l.date)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Macros today</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {nutrition && nutrition.entries.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-6 text-sm">
                <div>
                  <p className="text-2xl font-semibold">
                    {nutrition.totals.calories}
                    {nutrition.calorieGoal != null && (
                      <span className="text-base font-normal text-muted-foreground">
                        {" "}
                        / {nutrition.calorieGoal}
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground">kcal</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold">{nutrition.totals.protein}g</p>
                  <p className="text-muted-foreground">protein</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold">{nutrition.totals.carbs}g</p>
                  <p className="text-muted-foreground">carbs</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold">{nutrition.totals.fat}g</p>
                  <p className="text-muted-foreground">fat</p>
                </div>
              </div>
              {nutrition.calorieGoal != null &&
                nutrition.totals.calories > nutrition.calorieGoal && (
                  <p className="text-sm text-destructive">
                    {nutrition.totals.calories - nutrition.calorieGoal} kcal over today&apos;s goal
                  </p>
                )}
              <ul className="text-sm text-muted-foreground">
                {nutrition.entries.map((e) => (
                  <li key={e.id} className="flex items-center gap-2">
                    <span>
                      {e.item} — {e.calories} kcal (P{e.protein}/C{e.carbs}/F{e.fat})
                    </span>
                    {e.source === "photo" && (
                      <span title="Photo estimates are rough approximations" className="rounded bg-muted px-1 text-xs">
                        photo ≈
                      </span>
                    )}
                    <button
                      className="text-xs underline-offset-2 hover:underline"
                      onClick={async () => {
                        await fetch(`/api/nutrition?id=${e.id}`, { method: "DELETE" });
                        await load();
                      }}
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing logged today. Tell the agent what you ate (&quot;log a chicken burrito,
              ~700 calories&quot;) or send a photo/text to the macro sidecar. Set a{" "}
              <code>calories_per_day</code> goal on the Goals page to track against a target.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>LeetCode</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {leetcode ? (
            <div className="flex flex-wrap gap-6 text-sm">
              <div>
                <p className="text-2xl font-semibold">{leetcode.total_solved}</p>
                <p className="text-muted-foreground">total solved</p>
              </div>
              <div>
                <p className="text-2xl font-semibold">{leetcode.streak}</p>
                <p className="text-muted-foreground">day streak</p>
              </div>
              <div>
                <p className="text-2xl font-semibold">{leetcode.date}</p>
                <p className="text-muted-foreground">last updated</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No stats yet. Refresh from LeetCode (set LEETCODE_USERNAME) or enter manually.
            </p>
          )}
          {leetcode?.recent && leetcode.recent.length > 0 && (
            <div className="text-sm">
              <p className="mb-1 font-medium">Recently accepted</p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {leetcode.recent.slice(0, 5).map((p, i) => (
                  <li key={i}>{p.title}</li>
                ))}
              </ul>
            </div>
          )}
          {lcError && <p className="text-sm text-destructive">{lcError}</p>}
          <div className="flex flex-wrap items-end gap-3">
            <Button onClick={refreshLeetcode} disabled={busy} variant="outline">
              Refresh from LeetCode
            </Button>
            <form onSubmit={submitManual} className="flex items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="lc-total" className="text-xs">
                  Total solved
                </Label>
                <Input
                  id="lc-total"
                  type="number"
                  min={0}
                  value={manualTotal}
                  onChange={(e) => setManualTotal(e.target.value)}
                  className="w-28"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="lc-streak" className="text-xs">
                  Streak
                </Label>
                <Input
                  id="lc-streak"
                  type="number"
                  min={0}
                  value={manualStreak}
                  onChange={(e) => setManualStreak(e.target.value)}
                  className="w-24"
                />
              </div>
              <Button type="submit" disabled={busy || manualTotal === ""} variant="secondary">
                Save manual entry
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
