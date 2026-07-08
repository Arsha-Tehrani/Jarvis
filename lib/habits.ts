import { getDb } from "@/lib/db";

// Generic habits: daily cadence tracks a consecutive-day streak; weekly
// cadence tracks this week's count against `goal` per week.

export type Habit = {
  id: number;
  name: string;
  cadence: "daily" | "weekly";
  goal: number;
};

export type HabitWithStats = Habit & {
  dates: string[]; // logged dates, last ~53 weeks (heatmap)
  doneToday: boolean;
  streak: number; // consecutive days (daily cadence)
  thisWeek: number; // logs in the last 7 days
};

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

export function listHabits(): HabitWithStats[] {
  const db = getDb();
  const habits = db
    // Manual habits only (source IS NULL): sourced trackers (former Goals)
    // have no habit_logs and render as rings on the Trackers page.
    .prepare("SELECT id, name, cadence, goal FROM habits WHERE source IS NULL ORDER BY name")
    .all() as Habit[];
  const today = new Date().toISOString().slice(0, 10);
  const since = isoDaysAgo(370);

  return habits.map((habit) => {
    const dates = (
      db
        .prepare(
          "SELECT date FROM habit_logs WHERE habit_id = ? AND date >= ? ORDER BY date DESC"
        )
        .all(habit.id, since) as { date: string }[]
    ).map((r) => r.date);
    const set = new Set(dates);

    // Streak: consecutive days ending today (or yesterday if today not yet logged).
    let streak = 0;
    let cursor = set.has(today) ? today : isoDaysAgo(1);
    while (set.has(cursor)) {
      streak++;
      cursor = new Date(Date.parse(cursor) - 86400_000).toISOString().slice(0, 10);
    }

    const weekAgo = isoDaysAgo(7);
    const thisWeek = dates.filter((d) => d > weekAgo).length;

    return { ...habit, dates, doneToday: set.has(today), streak, thisWeek };
  });
}

export function logHabitByName(name: string, date?: string): string {
  const db = getDb();
  const habit = db
    .prepare("SELECT id, name FROM habits WHERE LOWER(name) = LOWER(?)")
    .get(name.trim()) as { id: number; name: string } | undefined;
  if (!habit) {
    const names = (db.prepare("SELECT name FROM habits ORDER BY name").all() as { name: string }[])
      .map((r) => r.name)
      .join(", ");
    throw new Error(
      `No habit named "${name}". Existing habits: ${names || "(none — create one on the Habits page first)"}`
    );
  }
  const day = date ?? new Date().toISOString().slice(0, 10);
  db.prepare("INSERT OR IGNORE INTO habit_logs (habit_id, date) VALUES (?, ?)").run(
    habit.id,
    day
  );
  return `Logged "${habit.name}" for ${day}.`;
}
