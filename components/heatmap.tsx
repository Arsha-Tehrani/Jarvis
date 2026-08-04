"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// GitHub-style contribution grid: 53 columns of weeks, rows Sun–Sat.
// Binary cells — the day is either logged or it isn't. Shared by the gym
// tracker and every habit.
//
// Manual correction: when `onCorrect` is provided, clicking a day opens a
// small confirm bar (this app's pattern: data-altering actions are
// confirm-gated, never fired on the first click) showing the day's current
// state and offering only the opposite action — a misclick can't silently
// double-log or un-log the wrong day. Future days are never offered.
export function ContributionHeatmap({
  loggedDates,
  onCorrect,
}: {
  loggedDates: string[];
  // Called after the user confirms: action is what should happen to date.
  onCorrect?: (date: string, action: "log" | "unlog") => Promise<void> | void;
}) {
  const logged = new Set(loggedDates);
  const today = new Date();
  const todayKey = toKey(today);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function confirm(date: string, action: "log" | "unlog") {
    if (!onCorrect) return;
    setBusy(true);
    try {
      await onCorrect(date, action);
      setSelected(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
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
                    onClick={onCorrect ? () => setSelected(date) : undefined}
                    className={cn(
                      "size-2.5 rounded-[2px]",
                      logged.has(date) ? "bg-(--heat-4)" : "bg-(--heat-1)",
                      date === todayKey && "ring-1 ring-foreground/40",
                      onCorrect && "cursor-pointer hover:ring-1 hover:ring-foreground/60",
                      selected === date && "ring-2 ring-foreground"
                    )}
                  />
                )
              )}
            </div>
          ))}
        </div>
      </div>
      {onCorrect && selected && (
        <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/40 px-2 py-1.5 text-sm">
          <span>
            <span className="font-medium">{selected}</span>
            {" — "}
            {logged.has(selected) ? "logged ✓" : "not logged"}
          </span>
          {logged.has(selected) ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm(selected, "unlog")}>
              Mark not done
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => confirm(selected, "log")}>
              Mark done
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function toKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
