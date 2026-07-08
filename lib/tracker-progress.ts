// Pure tracker progress/label logic (no DB import) so node --test proves it
// directly. The cadence-label bug this fixes: a DAILY tracker was showing
// "X per week" language, which is meaningless for a streak — daily trackers
// speak in streaks, weekly trackers speak in count-vs-target.

export type ManualStats = {
  streak: number; // consecutive days (daily)
  thisWeek: number; // logs in the last 7 days (weekly)
  goal: number; // weekly count target
  doneToday: boolean;
};

// Human label for a MANUAL tracker (no linked data source), driven by cadence.
export function manualTrackerLabel(cadence: "daily" | "weekly", s: ManualStats): string {
  if (cadence === "daily") {
    const streakPart =
      s.streak === 1 ? "1-day streak" : `${s.streak}-day streak`;
    return `${streakPart} · ${s.doneToday ? "done today" : "not yet today"}`;
  }
  return `${s.thisWeek} of ${s.goal} this week`;
}

// Progress fraction [0,1] for a manual tracker. Daily has no fixed target, so a
// streak is treated as "on track" once today is done (fraction 1 when done, a
// gentle 0.5 mid-streak, 0 when the streak has lapsed).
export function manualFraction(cadence: "daily" | "weekly", s: ManualStats): number {
  if (cadence === "daily") return s.doneToday ? 1 : s.streak > 0 ? 0.5 : 0;
  return s.goal > 0 ? Math.max(0, Math.min(1, s.thisWeek / s.goal)) : 0;
}

export function manualOnTrack(cadence: "daily" | "weekly", s: ManualStats): boolean {
  return cadence === "daily" ? s.doneToday : s.thisWeek >= s.goal;
}

// A sourced tracker (former Goal) renders a ring against its numeric target.
// Most are floors (more is better); calories is a ceiling.
export function sourcedOnTrack(source: string, actual: number, target: number): boolean {
  return source === "calories" ? actual <= target : actual >= target;
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
