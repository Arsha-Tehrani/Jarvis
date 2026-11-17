// Pure tracker progress/label logic (no DB import) so node --test proves it
// directly. The cadence-label bug this fixes: a DAILY tracker was showing
// "X per week" language, which is meaningless for a streak — daily trackers
// speak in streaks, weekly trackers speak in count-vs-target.

export type ManualStats = {
  streak: number; // consecutive days (daily)
  thisWeek: number; // logs in the last 7 days (weekly)
  goal: number; // weekly count target
  doneToday: boolean;
  missedToday?: boolean; // explicit "no" for today via the Slack check-in
};

const dayBefore = (iso: string): string =>
  new Date(Date.parse(iso) - 86400_000).toISOString().slice(0, 10);

// Consecutive-day streak ending today, with the "not yet today" grace period
// that lets a streak survive until the day is over.
//
// The one thing an EXPLICIT MISS changes: it revokes that grace. A day with no
// data is ambiguous — maybe you did it and haven't logged it — so an unlogged
// today keeps counting back from yesterday, exactly as before. A day you
// answered "no" to is not ambiguous, so it breaks the streak outright.
// Earlier days need no special case: a missed day is by definition unlogged,
// and the walk already stops at the first unlogged day.
export function dailyStreak(
  loggedDates: Iterable<string>,
  missedDates: Iterable<string>,
  today: string
): number {
  const logged = new Set(loggedDates);
  if (new Set(missedDates).has(today)) return 0;
  let streak = 0;
  let cursor = logged.has(today) ? today : dayBefore(today);
  while (logged.has(cursor)) {
    streak++;
    cursor = dayBefore(cursor);
  }
  return streak;
}

// Human label for a MANUAL tracker (no linked data source), driven by cadence.
export function manualTrackerLabel(cadence: "daily" | "weekly", s: ManualStats): string {
  if (cadence === "daily") {
    const streakPart =
      s.streak === 1 ? "1-day streak" : `${s.streak}-day streak`;
    const todayPart = s.doneToday
      ? "done today"
      : s.missedToday
        ? "missed today"
        : "not yet today";
    return `${streakPart} · ${todayPart}`;
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
