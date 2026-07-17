"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  eventDayKeys,
  eventTimeLabel,
  isAllDay,
  localDateKey,
  monthGrid,
  taskDayKey,
  weekOf,
} from "@/lib/calendar-grid";

type CalEvent = {
  google_event_id: string;
  title: string;
  start: string;
  end: string;
  updated_at: string;
};

type Priority = "urgent" | "high" | "later";

type Task = {
  id: number;
  title: string;
  due_at: string | null;
  priority: Priority;
  status: "open" | "done";
  source: string;
};

const CALLBACK_MESSAGES: Record<string, string> = {
  connected: "Google Calendar connected.",
  denied: "Google sign-in was cancelled.",
  state_mismatch: "Sign-in state didn't match (try connecting again).",
  exchange_failed: "Token exchange failed — check the OAuth client credentials.",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmt(when: string): string {
  if (isAllDay(when)) return `${when} (all day)`;
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return when;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CalendarView() {
  const params = useSearchParams();
  const flag = params.get("google");
  const [configured, setConfigured] = useState(true);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"month" | "week">("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Quick-add-task form (local tasks, never a Google event — Tasks stay a
  // separate local list; Google remains the calendar's single source of truth).
  const [addTitle, setAddTitle] = useState("");
  const [addPriority, setAddPriority] = useState<Priority>("high");
  const [addDue, setAddDue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    // Google and tasks load independently — a Google failure never hides
    // local tasks, and vice versa.
    try {
      const res = await fetch("/api/google");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load calendar");
      setConfigured(data.configured);
      setConnected(data.connected);
      setEvents(data.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load calendar");
    }
    try {
      const res = await fetch("/api/tasks");
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks as Task[]);
      }
    } catch {
      // tasks just won't show on the grid; the grid itself still renders
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: "connect" | "poll" | "disconnect") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `${action} failed`);
        return;
      }
      if (action === "connect" && data.authUrl) {
        window.location.href = data.authUrl;
        return;
      }
      await load();
    } catch {
      setError("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  // day key → that day's events, timed ones sorted by start, all-day first.
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      for (const key of eventDayKeys(e.start, e.end)) {
        const list = map.get(key) ?? [];
        list.push(e);
        map.set(key, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const aAll = isAllDay(a.start) ? 0 : 1;
        const bAll = isAllDay(b.start) ? 0 : 1;
        return aAll - bAll || a.start.localeCompare(b.start);
      });
    }
    return map;
  }, [events]);

  // day key → open tasks due that day (done tasks stay off the grid). Uses the
  // pure taskDayKey so date-only and full-timestamp due dates land on the
  // right cell without a UTC shift.
  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.status !== "open") continue;
      const key = taskDayKey(t.due_at);
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    }
    return map;
  }, [tasks]);

  const days = useMemo(
    () =>
      view === "month" ? monthGrid(cursor.getFullYear(), cursor.getMonth()) : weekOf(cursor),
    [view, cursor]
  );

  const todayKey = localDateKey(new Date());
  const cursorMonth = cursor.getMonth();

  function shift(direction: -1 | 1) {
    setCursor((c) =>
      view === "month"
        ? new Date(c.getFullYear(), c.getMonth() + direction, 1)
        : new Date(c.getFullYear(), c.getMonth(), c.getDate() + 7 * direction)
    );
  }

  const rangeLabel =
    view === "month"
      ? cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" })
      : `${days[0]?.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${days[6]?.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  const selectedEvents = selectedDay ? (eventsByDay.get(selectedDay) ?? []) : [];
  const selectedTasks = selectedDay ? (tasksByDay.get(selectedDay) ?? []) : [];
  const lastPolled = events[0]?.updated_at;

  function selectDay(key: string) {
    setSelectedDay(key);
    setAddDue(key);
    setAddError(null);
  }

  // The + on a day cell: select that day and jump straight to the add-task
  // title field so the form is one keystroke away.
  function openAdd(key: string) {
    selectDay(key);
    requestAnimationFrame(() => titleRef.current?.focus());
  }

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    if (!addTitle.trim() || !selectedDay) return;
    setAddBusy(true);
    setAddError(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: addTitle.trim(),
          due_at: (addDue || selectedDay) || null,
          priority: addPriority,
          source: "calendar",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAddError(data.error ?? "Failed to add task");
        return;
      }
      setAddTitle("");
      setAddPriority("high");
      await load(); // refetch so it appears on the grid immediately
    } catch {
      setAddError("Could not reach the API.");
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {flag && (
        <p className="text-sm text-muted-foreground">
          {CALLBACK_MESSAGES[flag] ?? flag}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Google connection state is a banner, not a wall — the grid and its
          local tasks/quick-add work with or without Google connected. */}
      {!configured ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Google Calendar isn&apos;t configured, so only your tasks show here. Set
            GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local (OAuth client
            redirect:{" "}
            <code className="rounded bg-muted px-1">
              http://localhost:3000/api/google/callback
            </code>
            ) to pull in calendar events.
          </CardContent>
        </Card>
      ) : !connected ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6 text-sm">
            <p className="text-muted-foreground">
              Google Calendar not connected — showing your tasks only. Google is the
              source of truth for events; connect to read it back on open and hourly.
            </p>
            <Button onClick={() => act("connect")} disabled={busy}>
              Connect Google Calendar
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="min-w-40">{rangeLabel}</span>
            <span className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => shift(-1)} aria-label="Previous">
                ‹
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCursor(new Date());
                  selectDay(todayKey);
                }}
              >
                Today
              </Button>
              <Button variant="outline" size="sm" onClick={() => shift(1)} aria-label="Next">
                ›
              </Button>
            </span>
            <span className="ml-auto flex gap-1">
              <Button
                variant={view === "month" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setView("month")}
              >
                Month
              </Button>
              <Button
                variant={view === "week" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setView("week")}
              >
                Week
              </Button>
              {connected && (
                <>
                  <Button variant="outline" size="sm" onClick={() => act("poll")} disabled={busy}>
                    Refresh
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => act("disconnect")} disabled={busy}>
                    Disconnect
                  </Button>
                </>
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border bg-border">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="bg-muted px-2 py-1 text-center text-xs font-medium text-muted-foreground"
              >
                {d}
              </div>
            ))}
            {days.map((day) => {
              const key = localDateKey(day);
              const dayEvents = eventsByDay.get(key) ?? [];
              const dayTasks = tasksByDay.get(key) ?? [];
              const outside = view === "month" && day.getMonth() !== cursorMonth;
              const isToday = key === todayKey;
              // Month view caps the combined list; week view (taller cells)
              // shows everything.
              const cap = view === "month" ? 3 : Infinity;
              const shownEvents = dayEvents.slice(0, cap);
              const remainingCap = cap - shownEvents.length;
              const shownTasks = dayTasks.slice(0, Math.max(0, remainingCap));
              const overflow =
                dayEvents.length + dayTasks.length - shownEvents.length - shownTasks.length;
              return (
                <div
                  key={key}
                  className={`group relative flex flex-col ${outside ? "opacity-40" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => selectDay(key)}
                    className={`flex flex-1 flex-col items-stretch gap-1 bg-background p-1.5 text-left align-top transition-colors hover:bg-accent/50 ${
                      view === "month" ? "min-h-24" : "min-h-48"
                    } ${selectedDay === key ? "bg-accent/60" : ""}`}
                  >
                    <span
                      className={`self-start rounded-[var(--radius)] px-1.5 text-xs ${
                        isToday
                          ? "bg-primary font-semibold text-primary-foreground"
                          : "text-muted-foreground"
                      }`}
                    >
                      {day.getDate()}
                    </span>
                    {shownEvents.map((e) => (
                      <span
                        key={`${e.google_event_id}:${key}`}
                        className="truncate rounded bg-primary/10 px-1 py-0.5 text-xs text-primary"
                        title={e.title}
                      >
                        {eventTimeLabel(e.start) && (
                          <span className="mr-1 text-[10px] text-muted-foreground">
                            {eventTimeLabel(e.start)}
                          </span>
                        )}
                        {e.title}
                      </span>
                    ))}
                    {shownTasks.map((t) => (
                      <span
                        key={`task:${t.id}`}
                        className="truncate rounded border-l-2 border-warn bg-muted/70 px-1 py-0.5 text-xs text-foreground"
                        title={`Task: ${t.title}`}
                      >
                        <span className="mr-1 text-[10px] text-muted-foreground">○</span>
                        {t.title}
                      </span>
                    ))}
                    {overflow > 0 && (
                      <span className="px-1 text-[10px] text-muted-foreground">
                        +{overflow} more
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Add task on ${key}`}
                    onClick={() => openAdd(key)}
                    className="absolute right-1 top-1 hidden size-5 items-center justify-center rounded-[var(--radius)] border border-line bg-background text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground group-hover:flex"
                  >
                    +
                  </button>
                </div>
              );
            })}
          </div>
          {lastPolled && (
            <p className="mt-3 text-xs text-muted-foreground">
              Last polled {fmt(lastPolled)} — polls on app open and hourly.
            </p>
          )}
        </CardContent>
      </Card>

      {selectedDay && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              {new Date(`${selectedDay}T12:00:00`).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              <Button variant="ghost" size="sm" onClick={() => setSelectedDay(null)}>
                ✕
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {selectedEvents.length === 0 && selectedTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing scheduled this day.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {selectedEvents.map((e) => (
                  <li
                    key={e.google_event_id}
                    className="flex items-baseline gap-3 py-2 text-sm"
                  >
                    <span className="w-28 shrink-0 text-muted-foreground">
                      {isAllDay(e.start) ? "All day" : eventTimeLabel(e.start)}
                    </span>
                    <span className="font-medium">{e.title}</span>
                  </li>
                ))}
                {selectedTasks.map((t) => (
                  <li key={`task:${t.id}`} className="flex items-baseline gap-3 py-2 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">Task</span>
                    <span className="font-medium">
                      <span className="mr-1 text-muted-foreground">○</span>
                      {t.title}
                    </span>
                    <span className="ml-auto text-xs capitalize text-muted-foreground">
                      {t.priority}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* Quick-add: a local task due this day. Reuses POST /api/tasks
                (source='calendar'); no new endpoint, no Google write. */}
            <form onSubmit={addTask} className="flex flex-col gap-2 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">Add a task</p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="cal-task-title" className="text-xs">
                    Title
                  </Label>
                  <Input
                    id="cal-task-title"
                    ref={titleRef}
                    value={addTitle}
                    onChange={(e) => setAddTitle(e.target.value)}
                    placeholder="Call the bank"
                    className="w-56"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">Priority</Label>
                  <Select
                    value={addPriority}
                    onValueChange={(v) => setAddPriority(v as Priority)}
                  >
                    <SelectTrigger className="w-28" aria-label="Priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="urgent">Urgent</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="later">Later</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="cal-task-due" className="text-xs">
                    Due
                  </Label>
                  <Input
                    id="cal-task-due"
                    type="date"
                    value={addDue}
                    onChange={(e) => setAddDue(e.target.value)}
                    className="w-40"
                  />
                </div>
                <Button type="submit" disabled={addBusy || !addTitle.trim()}>
                  Add task
                </Button>
              </div>
              {addError && <p className="text-sm text-destructive">{addError}</p>}
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
