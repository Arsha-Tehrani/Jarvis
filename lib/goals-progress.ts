import { getDb } from "@/lib/db";
import { monthSummaries } from "@/lib/finance/analyze";
import { listHabits } from "@/lib/habits";

// One view over every target the user has set: rows from the goals table
// plus each habit's weekly goal, with actuals computed from the relevant
// tables. Deterministic — no LLM anywhere near this.

export type GoalProgress = {
  key: string; // stable id for React keys ("goal:3" | "habit:2")
  goalId: number | null; // goals-table id (null for habit goals)
  kind: string;
  label: string;
  target: number;
  actual: number;
  unit: string;
  fraction: number; // actual/target clamped to [0,1]
  onTrack: boolean;
  displayActual: string;
  href: string;
};

const GOAL_LABELS: Record<string, string> = {
  savings_rate: "Savings rate",
  gym_days_per_week: "Gym days",
  leetcode_per_week: "LeetCode problems",
  sleep_hours: "Avg sleep",
};

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function computeGoalsProgress(): GoalProgress[] {
  const db = getDb();
  const weekAgo = isoDaysAgo(7);
  const progress: GoalProgress[] = [];

  const goals = db
    .prepare("SELECT id, kind, target, period FROM goals ORDER BY kind")
    .all() as { id: number; kind: string; target: number; period: string }[];

  for (const goal of goals) {
    let actual = 0;
    let unit = "";
    let displayActual = "";
    let href = "/finance";

    switch (goal.kind) {
      case "savings_rate": {
        const [, current] = monthSummaries();
        actual =
          current.income > 0
            ? ((current.income - current.spend) / current.income) * 100
            : 0;
        unit = "%";
        displayActual = `${actual.toFixed(0)}%`;
        href = "/finance";
        break;
      }
      case "gym_days_per_week": {
        actual = (
          db.prepare("SELECT COUNT(*) AS n FROM gym_logs WHERE date > ?").get(weekAgo) as {
            n: number;
          }
        ).n;
        unit = "days";
        displayActual = `${actual}`;
        href = "/trackers";
        break;
      }
      case "leetcode_per_week": {
        const latest = db
          .prepare("SELECT total_solved FROM leetcode_stats ORDER BY date DESC LIMIT 1")
          .get() as { total_solved: number } | undefined;
        const baseline = db
          .prepare(
            "SELECT total_solved FROM leetcode_stats WHERE date <= ? ORDER BY date DESC LIMIT 1"
          )
          .get(weekAgo) as { total_solved: number } | undefined;
        if (latest && baseline) {
          actual = Math.max(0, latest.total_solved - baseline.total_solved);
        } else {
          // No baseline a week back — count entry days as a proxy.
          actual = (
            db
              .prepare("SELECT COUNT(*) AS n FROM leetcode_stats WHERE date > ?")
              .get(weekAgo) as { n: number }
          ).n;
        }
        unit = "solved";
        displayActual = `${actual}`;
        href = "/trackers";
        break;
      }
      case "sleep_hours": {
        const avg = (
          db
            .prepare(
              "SELECT AVG(value) AS avg FROM health_logs WHERE kind = 'sleep_hours' AND date > ?"
            )
            .get(weekAgo) as { avg: number | null }
        ).avg;
        actual = avg ?? 0;
        unit = "h avg";
        displayActual = avg == null ? "no data" : `${avg.toFixed(1)}h`;
        href = "/health";
        break;
      }
      default:
        continue; // unknown kind — skip rather than mislead
    }

    progress.push({
      key: `goal:${goal.id}`,
      goalId: goal.id,
      kind: goal.kind,
      label: GOAL_LABELS[goal.kind] ?? goal.kind,
      target: goal.target,
      actual,
      unit,
      fraction: goal.target > 0 ? clamp01(actual / goal.target) : 0,
      onTrack: actual >= goal.target,
      displayActual: displayActual || `${actual}`,
      href,
    });
  }

  // Habit goals: each habit tracks its own per-week target.
  for (const habit of listHabits()) {
    progress.push({
      key: `habit:${habit.id}`,
      goalId: null,
      kind: "habit",
      label: habit.name,
      target: habit.goal,
      actual: habit.thisWeek,
      unit: "this week",
      fraction: habit.goal > 0 ? clamp01(habit.thisWeek / habit.goal) : 0,
      onTrack: habit.thisWeek >= habit.goal,
      displayActual: `${habit.thisWeek}`,
      href: "/habits",
    });
  }

  return progress;
}
