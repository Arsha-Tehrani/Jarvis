import { getDb } from "@/lib/db";
import { monthSummaries } from "@/lib/finance/analyze";
import {
  clamp01,
  manualFraction,
  manualOnTrack,
  manualTrackerLabel,
  sourcedOnTrack,
} from "@/lib/tracker-progress";
import { findLikelyDuplicate, type DuplicateSuggestion } from "@/lib/tracker-dedupe";

// The unified Tracker model. A Tracker is a row in the generalized `habits`
// table. `source` links it to a built-in feed (gym_logs, leetcode, sleep,
// calories, savings) or is null for a manual habit. Sourced trackers carry a
// numeric `target` and render as a ring (the former Goals); manual trackers
// render as a heatmap/streak. Progress is always computed from real logged
// data — never a static, unincrementable number.

export type Tracker = {
  id: number;
  name: string;
  cadence: "daily" | "weekly";
  source: string | null;
  target: number | null;
  goal: number;
  display: "ring" | "heatmap";
  actual: number;
  targetValue: number;
  unit: string;
  fraction: number;
  onTrack: boolean;
  label: string;
  displayActual: string;
  streak: number;
  thisWeek: number;
  doneToday: boolean;
  dates: string[];
  // All-time logged-entry count (manual trackers only; 0 for sourced) — the
  // delete confirmation says exactly how many entries would be lost.
  logCount: number;
  href: string;
};

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

// Actual value + presentation for a built-in source (the former Goal kinds).
function sourcedActual(source: string): {
  actual: number;
  unit: string;
  displayActual: string;
  href: string;
} {
  const db = getDb();
  const weekAgo = isoDaysAgo(7);
  switch (source) {
    case "savings_rate": {
      const { current } = monthSummaries();
      const actual =
        current.income > 0 ? ((current.income - current.spend) / current.income) * 100 : 0;
      return { actual, unit: "%", displayActual: `${actual.toFixed(0)}%`, href: "/finance" };
    }
    case "gym_logs": {
      const actual = (
        db.prepare("SELECT COUNT(*) AS n FROM gym_logs WHERE date > ?").get(weekAgo) as { n: number }
      ).n;
      return { actual, unit: "days", displayActual: `${actual}`, href: "/trackers" };
    }
    case "leetcode": {
      const latest = db
        .prepare("SELECT total_solved FROM leetcode_stats ORDER BY date DESC LIMIT 1")
        .get() as { total_solved: number } | undefined;
      const baseline = db
        .prepare("SELECT total_solved FROM leetcode_stats WHERE date <= ? ORDER BY date DESC LIMIT 1")
        .get(weekAgo) as { total_solved: number } | undefined;
      const actual =
        latest && baseline
          ? Math.max(0, latest.total_solved - baseline.total_solved)
          : (db.prepare("SELECT COUNT(*) AS n FROM leetcode_stats WHERE date > ?").get(weekAgo) as {
              n: number;
            }).n;
      return { actual, unit: "solved", displayActual: `${actual}`, href: "/trackers" };
    }
    case "sleep_hours": {
      const avg = (
        db
          .prepare("SELECT AVG(value) AS avg FROM health_logs WHERE kind = 'sleep_hours' AND date > ?")
          .get(weekAgo) as { avg: number | null }
      ).avg;
      return {
        actual: avg ?? 0,
        unit: "h avg",
        displayActual: avg == null ? "no data" : `${avg.toFixed(1)}h`,
        href: "/health",
      };
    }
    case "calories": {
      const today = new Date().toISOString().slice(0, 10);
      const actual = (
        db
          .prepare("SELECT COALESCE(SUM(calories), 0) AS total FROM nutrition_logs WHERE date = ?")
          .get(today) as { total: number }
      ).total;
      return { actual, unit: "kcal", displayActual: `${actual} kcal`, href: "/trackers" };
    }
    default:
      return { actual: 0, unit: "", displayActual: "0", href: "/trackers" };
  }
}

export function listTrackers(): Tracker[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, name, cadence, goal, source, target FROM habits ORDER BY (source IS NULL), name")
    .all() as {
    id: number;
    name: string;
    cadence: "daily" | "weekly";
    goal: number;
    source: string | null;
    target: number | null;
  }[];
  const today = new Date().toISOString().slice(0, 10);
  const since = isoDaysAgo(370);

  return rows.map((r) => {
    if (r.source) {
      // Sourced tracker → ring against its numeric target.
      const { actual, unit, displayActual, href } = sourcedActual(r.source);
      const target = r.target ?? 0;
      return {
        ...r,
        display: "ring" as const,
        actual,
        targetValue: target,
        unit,
        fraction: target > 0 ? clamp01(actual / target) : 0,
        onTrack: sourcedOnTrack(r.source, actual, target),
        label: `${displayActual} of ${target}${unit === "%" ? "%" : ` ${unit}`}`,
        displayActual,
        streak: 0,
        thisWeek: 0,
        doneToday: false,
        dates: [],
        logCount: 0,
        href,
      };
    }

    // Manual tracker → heatmap + cadence-correct streak/count label.
    const dates = (
      db
        .prepare("SELECT date FROM habit_logs WHERE habit_id = ? AND date >= ? ORDER BY date DESC")
        .all(r.id, since) as { date: string }[]
    ).map((x) => x.date);
    const set = new Set(dates);
    let streak = 0;
    let cursor = set.has(today) ? today : isoDaysAgo(1);
    while (set.has(cursor)) {
      streak++;
      cursor = new Date(Date.parse(cursor) - 86400_000).toISOString().slice(0, 10);
    }
    const thisWeek = dates.filter((d) => d > isoDaysAgo(7)).length;
    const doneToday = set.has(today);
    const logCount = (
      db.prepare("SELECT COUNT(*) AS n FROM habit_logs WHERE habit_id = ?").get(r.id) as {
        n: number;
      }
    ).n;
    const stats = { streak, thisWeek, goal: r.goal, doneToday };
    return {
      ...r,
      display: "heatmap" as const,
      actual: r.cadence === "daily" ? streak : thisWeek,
      targetValue: r.cadence === "daily" ? 0 : r.goal,
      unit: r.cadence === "daily" ? "day streak" : "this week",
      fraction: manualFraction(r.cadence, stats),
      onTrack: manualOnTrack(r.cadence, stats),
      label: manualTrackerLabel(r.cadence, stats),
      displayActual: r.cadence === "daily" ? `${streak}` : `${thisWeek}`,
      streak,
      thisWeek,
      doneToday,
      dates,
      logCount,
      href: "/trackers",
    };
  });
}

// Backward-compatible progress list for the morning brief, weekly digest, and
// Today dashboard "goals at risk" — now sourced from the unified Trackers.
export type GoalProgress = {
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

export function computeGoalsProgress(): GoalProgress[] {
  return listTrackers().map((t) => ({
    key: `tracker:${t.id}`,
    goalId: t.source ? t.id : null,
    kind: t.source ?? "habit",
    label: t.name,
    target: t.targetValue,
    actual: t.actual,
    unit: t.unit,
    fraction: t.fraction,
    onTrack: t.onTrack,
    displayActual: t.displayActual,
    href: t.href,
  }));
}

// Duplicate check used by both the UI and the agent when creating a tracker:
// deterministic first (always runs), then an optional LLM pass elsewhere. A
// suggestion, never a block.
export function checkTrackerDuplicate(name: string): DuplicateSuggestion {
  const existing = getDb()
    .prepare("SELECT id, name, source FROM habits")
    .all() as { id: number; name: string; source: string | null }[];
  return findLikelyDuplicate(name, existing);
}
