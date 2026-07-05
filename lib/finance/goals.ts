import { getDb } from "@/lib/db";

export const GOAL_KINDS = [
  "savings_rate",
  "gym_days_per_week",
  "leetcode_per_week",
] as const;

export type GoalKind = (typeof GOAL_KINDS)[number];

export const DEFAULT_PERIOD: Record<GoalKind, "week" | "month"> = {
  savings_rate: "month",
  gym_days_per_week: "week",
  leetcode_per_week: "week",
};

export function upsertGoal(kind: GoalKind, target: number, period?: "week" | "month"): void {
  getDb()
    .prepare(
      `INSERT INTO goals (kind, target, period) VALUES (?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET target = excluded.target, period = excluded.period`
    )
    .run(kind, target, period ?? DEFAULT_PERIOD[kind]);
}
