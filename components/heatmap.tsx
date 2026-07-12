"use client";

import { cn } from "@/lib/utils";

// GitHub-style contribution grid: 53 columns of weeks, rows Sun–Sat.
// Binary cells — the day is either logged or it isn't. Shared by the gym
// tracker and every habit.
export function ContributionHeatmap({ loggedDates }: { loggedDates: string[] }) {
  const logged = new Set(loggedDates);
  const today = new Date();
  const todayKey = toKey(today);

  // Start on the Sunday 52 full weeks before this week.
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - 52 * 7);

  const weeks: string[][] = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(cursor <= today ? toKey(cursor) : "");
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-0.5">
        {weeks.map((week, w) => (
          <div key={w} className="flex flex-col gap-0.5">
            {week.map((date, d) =>
              date === "" ? (
                <div key={d} className="size-2.5" />
              ) : (
                <div
                  key={d}
                  title={`${date}${logged.has(date) ? " ✓" : ""}`}
                  className={cn(
                    "size-2.5 rounded-[2px]",
                    logged.has(date) ? "bg-(--heat-4)" : "bg-(--heat-1)",
                    date === todayKey && "ring-1 ring-foreground/40"
                  )}
                />
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function toKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
