import { getDb } from "@/lib/db";
import { setTrackerTarget } from "@/lib/trackers-migrate";

export const GOAL_KINDS = [
  "savings_rate",
  "gym_days_per_week",
  "leetcode_per_week",
  "sleep_hours",
  "calories_per_day",
] as const;

export type GoalKind = (typeof GOAL_KINDS)[number];

export const DEFAULT_PERIOD: Record<GoalKind, "week" | "month"> = {
  savings_rate: "month",
  gym_days_per_week: "week",
  leetcode_per_week: "week",
  sleep_hours: "week", // target = average hours/night over the past week
  calories_per_day: "week", // target is per-day; measured daily, reviewed weekly
};

// Goals are folded into the unified Tracker model (Part E): "setting a goal" is
// now setting a target on the corresponding Tracker. `period` is retained in
// the signature for call-site compatibility but is no longer stored (the
// Tracker's source drives its measurement window). The legacy `goals` table is
// no longer written.
export function upsertGoal(kind: GoalKind, target: number, _period?: "week" | "month"): void {
  setTrackerTarget(getDb(), kind, target);
}
