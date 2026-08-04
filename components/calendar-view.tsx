"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  taskMirrorEventIds,
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
  gcal_event_id: string | null;
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

  // Quick-add: Task and Event are two distinct actions reachable from the
  // same day-cell "+"/detail panel, never navigating away.
  //  - Task: a local `tasks` row, never synced to Google (unchanged from
  //    Round 1) — kept exactly as it was.
  //  - Event: a real Google Calendar event, written through the exact same
  //    createCalendarEvent() the agent's create_calendar_event/set_reminder
  //    tools use, just triggered from this form instead of the LLM.
  const [addMode, setAddMode] = useState<"task" | "event">("task");

  // Quick-add-task form (local tasks, never a Google event — Tasks stay a
  // separate local list; Google remains the calendar's single source of truth).
  const [addTitle, setAddTitle] = useState("");
  const [addPriority, setAddPriority] = useState<Priority>("high");
  const [addDue, setAddDue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Quick-add-event form (real Google Calendar event via POST /api/calendar/events).
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventAllDay, setEventAllDay] = useState(false);
  const [eventStartTime, setEventStartTime] = useState("09:00");
  const [eventEndTime, setEventEndTime] = useState("");
  const [eventDescription, setEventDescription] = useState("");
  const [eventError, setEventError] = useState<string | null>(null);
  const [eventBusy, setEventBusy] = useState(false);
  const eventTitleRef = useRef<HTMLInputElement>(null);

  // Edit/delete for GENUINE Google events only. Task chips never open this —
  // they dispatch to the Tasks page's own edit UI (see taskChipHref), because
  // editing a task's mirror event directly would desync it from the task.
  const [editEvent, setEditEvent] = useState<CalEvent | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editAllDay, setEditAllDay] = useState(false);
  const [editStartTime, setEditStartTime] = useState("09:00");
  const [editEndTime, setEditEndTime] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

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

  // See lib/calendar-grid.ts's taskMirrorEventIds doc comment: every task
  // write already mirrors a real "Task: {title}" Google event, which would
  // otherwise render a second, plain entry here alongside the color-coded
  // task chip below. Filtering by the already-fetched gcal_event_id means no
  // second data fetch — a genuine Google event (no matching task) is
  // completely unaffected.
  const mirrorIds = useMemo(() => taskMirrorEventIds(tasks), [tasks]);

  // day key → that day's events, timed ones sorted by start, all-day first.
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      if (mirrorIds.has(e.google_event_id)) continue;
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
  }, [events, mirrorIds]);

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
    setEventDate(key);
    setEventError(null);
    setEditEvent(null);
    setEditError(null);
  }

  // Clicking a task chip routes to the Tasks page's edit UI (?task= expands
  // that card) — the one-line dispatch that keeps task mirrors out of the
  // Google edit/delete flow.
  function taskChipHref(t: Task): string {
    return `/tasks?task=${t.id}`;
  }

  function openEditEvent(e: CalEvent) {
    const allDay = isAllDay(e.start);
    setEditEvent(e);
    setEditTitle(e.title);
    setEditAllDay(allDay);
    setEditError(null);
    if (allDay) {
      setEditDate(e.start);
      setEditStartTime("09:00");
      setEditEndTime("");
    } else {
      const d = new Date(e.start);
      setEditDate(localDateKey(d));
      setEditStartTime(
        `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      );
      const end = new Date(e.end);
      setEditEndTime(
        Number.isNaN(end.getTime()) || localDateKey(end) !== localDateKey(d)
          ? ""
          : `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`
      );
    }
  }

  async function saveEventEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editEvent || !editTitle.trim() || !editDate) return;
    if (!editAllDay && !editStartTime) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const start = editAllDay ? editDate : `${editDate}T${editStartTime}:00`;
      const end = !editAllDay && editEndTime ? `${editDate}T${editEndTime}:00` : undefined;
      const res = await fetch(
        `/api/calendar/events/${encodeURIComponent(editEvent.google_event_id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: editTitle.trim(), start, end }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // OAuth failures surface the standard "…reconnect from the Calendar
        // tab" message verbatim, same as every other Google action here.
        setEditError(data.error ?? "Failed to update event");
        return;
      }
      setEditEvent(null);
      // The API route already re-polled Google server-side (read-back);
      // this refreshes local state from the now-current calendar_cache.
      await load();
    } catch {
      setEditError("Could not reach the API.");
    } finally {
      setEditBusy(false);
    }
  }

  async function removeEvent(ev: CalEvent) {
    // Destructive write against an external system → plain confirm, per the
    // same confirm-gated discipline as money actions and tracker deletion.
    if (!window.confirm(`Delete "${ev.title}" from Google Calendar?`)) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const res = await fetch(
        `/api/calendar/events/${encodeURIComponent(ev.google_event_id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEditError(data.error ?? "Failed to delete event");
        return;
      }
      if (editEvent?.google_event_id === ev.google_event_id) setEditEvent(null);
      await load();
    } catch {
      setEditError("Could not reach the API.");
    } finally {
      setEditBusy(false);
    }
  }

  // The + on a day cell: select that day, default to the Task tab (unchanged
  // quick-add behavior from Round 1), and jump straight to the title field.
  function openAdd(key: string) {
    selectDay(key);
    setAddMode("task");
    requestAnimationFrame(() => titleRef.current?.focus());
  }

  function openAddEvent(key: string) {
    selectDay(key);
    setAddMode("event");
    requestAnimationFrame(() => eventTitleRef.current?.focus());
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

  async function addEvent(e: React.FormEvent) {
    e.preventDefault();
    const date = eventDate || selectedDay;
    if (!eventTitle.trim() || !date) return;
    if (!eventAllDay && !eventStartTime) return; // a timed event needs a start time
    setEventBusy(true);
    setEventError(null);
    try {
      const start = eventAllDay ? date : `${date}T${eventStartTime}:00`;
      const end = !eventAllDay && eventEndTime ? `${date}T${eventEndTime}:00` : undefined;
      const res = await fetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: eventTitle.trim(),
          start,
          end,
          description: eventDescription.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Same message the rest of the page's Google actions surface — an
        // OAuth issue reads "…reconnect from the Calendar tab" verbatim, no
        // separate reconnect UI to build.
        setEventError(data.error ?? "Failed to add event");
        return;
      }
      setEventTitle("");
      setEventEndTime("");
      setEventDescription("");
      // The API route's createCalendarEvent() already re-polls Google
      // server-side (read-back, since Google is the source of truth) — this
      // just refreshes local state from the now-current calendar_cache,
      // never an optimistic fake event.
      await load();
    } catch {
      setEventError("Could not reach the API.");
    } finally {
      setEventBusy(false);
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
                  {/* The cell is a div (not a button) so the chips inside can
                      be real interactive elements: an event chip opens the
                      Google edit/delete flow, a task chip links to the Tasks
                      edit UI — never the other way around. */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => selectDay(key)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") selectDay(key);
                    }}
                    className={`flex flex-1 cursor-pointer flex-col items-stretch gap-1 bg-background p-1.5 text-left align-top transition-colors hover:bg-accent/50 ${
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
                      <button
                        type="button"
                        key={`${e.google_event_id}:${key}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          selectDay(key);
                          openEditEvent(e);
                        }}
                        className="truncate rounded bg-primary/10 px-1 py-0.5 text-left text-xs text-primary hover:bg-primary/20"
                        title={`Edit "${e.title}"`}
                      >
                        {eventTimeLabel(e.start) && (
                          <span className="mr-1 text-[10px] text-muted-foreground">
                            {eventTimeLabel(e.start)}
                          </span>
                        )}
                        {e.title}
                      </button>
                    ))}
                    {shownTasks.map((t) => (
                      <a
                        key={`task:${t.id}`}
                        href={taskChipHref(t)}
                        onClick={(ev) => ev.stopPropagation()}
                        className="truncate rounded border-l-2 border-warn bg-muted/70 px-1 py-0.5 text-xs text-foreground hover:bg-muted"
                        title={`Task: ${t.title} — edit on the Tasks page`}
                      >
                        <span className="mr-1 text-[10px] text-muted-foreground">○</span>
                        {t.title}
                      </a>
                    ))}
                    {overflow > 0 && (
                      <span className="px-1 text-[10px] text-muted-foreground">
                        +{overflow} more
                      </span>
                    )}
                  </div>
                  <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
                    <button
                      type="button"
                      aria-label={`Add task on ${key}`}
                      title="Add task"
                      onClick={() => openAdd(key)}
                      className="flex size-5 items-center justify-center rounded-[var(--radius)] border border-line bg-background text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      aria-label={`Add event on ${key}`}
                      title="Add event"
                      onClick={() => openAddEvent(key)}
                      className="flex size-5 items-center justify-center rounded-[var(--radius)] border border-line bg-background text-[10px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      🗓
                    </button>
                  </div>
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
                    <span className="ml-auto flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditEvent(e)}
                        disabled={editBusy}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => removeEvent(e)}
                        disabled={editBusy}
                      >
                        Delete
                      </Button>
                    </span>
                  </li>
                ))}
                {selectedTasks.map((t) => (
                  <li key={`task:${t.id}`} className="flex items-baseline gap-3 py-2 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">Task</span>
                    <span className="font-medium">
                      <span className="mr-1 text-muted-foreground">○</span>
                      {t.title}
                    </span>
                    <span className="ml-auto flex items-baseline gap-2">
                      <span className="text-xs capitalize text-muted-foreground">
                        {t.priority}
                      </span>
                      {/* Task rows dispatch to the Tasks page, never to the
                          Google event flow — the mirror must follow the task. */}
                      <Button variant="ghost" size="sm" asChild>
                        <a href={taskChipHref(t)}>Edit</a>
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {editEvent && (
              <form
                onSubmit={saveEventEdit}
                className="flex flex-col gap-2 rounded-md border border-line bg-muted/30 p-3"
              >
                <p className="text-xs font-medium text-muted-foreground">
                  Editing “{editEvent.title}” — saved straight to Google Calendar
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="cal-edit-title" className="text-xs">
                      Title
                    </Label>
                    <Input
                      id="cal-edit-title"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-56"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="cal-edit-date" className="text-xs">
                      Date
                    </Label>
                    <Input
                      id="cal-edit-date"
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="w-40"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 pb-2">
                    <Checkbox
                      id="cal-edit-allday"
                      checked={editAllDay}
                      onCheckedChange={(v) => setEditAllDay(v === true)}
                    />
                    <Label htmlFor="cal-edit-allday" className="text-xs">
                      All day
                    </Label>
                  </div>
                  {!editAllDay && (
                    <>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor="cal-edit-start" className="text-xs">
                          Start
                        </Label>
                        <Input
                          id="cal-edit-start"
                          type="time"
                          value={editStartTime}
                          onChange={(e) => setEditStartTime(e.target.value)}
                          className="w-28"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor="cal-edit-end" className="text-xs">
                          End
                        </Label>
                        <Input
                          id="cal-edit-end"
                          type="time"
                          value={editEndTime}
                          onChange={(e) => setEditEndTime(e.target.value)}
                          placeholder="+1h"
                          className="w-28"
                        />
                      </div>
                    </>
                  )}
                  <Button
                    type="submit"
                    disabled={
                      editBusy ||
                      !editTitle.trim() ||
                      !editDate ||
                      (!editAllDay && !editStartTime)
                    }
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setEditEvent(null)}
                    disabled={editBusy}
                  >
                    Cancel
                  </Button>
                </div>
                {editError && <p className="text-sm text-destructive">{editError}</p>}
              </form>
            )}
            {!editEvent && editError && (
              <p className="text-sm text-destructive">{editError}</p>
            )}

            {/* Task and Event are two distinct actions from the same panel —
                Task stays a local row (source='calendar', never synced to
                Google); Event is a real Google Calendar event via the same
                createCalendarEvent() the agent's tools use. */}
            <div className="flex flex-col gap-3 border-t pt-3">
              <div className="flex gap-1" role="tablist" aria-label="Add">
                <Button
                  type="button"
                  variant={addMode === "task" ? "secondary" : "ghost"}
                  size="sm"
                  role="tab"
                  aria-selected={addMode === "task"}
                  onClick={() => setAddMode("task")}
                >
                  + Task
                </Button>
                <Button
                  type="button"
                  variant={addMode === "event" ? "secondary" : "ghost"}
                  size="sm"
                  role="tab"
                  aria-selected={addMode === "event"}
                  onClick={() => setAddMode("event")}
                >
                  + Event
                </Button>
              </div>

              {addMode === "task" ? (
                <form onSubmit={addTask} className="flex flex-col gap-2">
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
              ) : (
                <form onSubmit={addEvent} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="cal-event-title" className="text-xs">
                        Title
                      </Label>
                      <Input
                        id="cal-event-title"
                        ref={eventTitleRef}
                        value={eventTitle}
                        onChange={(e) => setEventTitle(e.target.value)}
                        placeholder="Dentist appointment"
                        className="w-56"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="cal-event-date" className="text-xs">
                        Date
                      </Label>
                      <Input
                        id="cal-event-date"
                        type="date"
                        value={eventDate}
                        onChange={(e) => setEventDate(e.target.value)}
                        className="w-40"
                      />
                    </div>
                    <div className="flex items-center gap-1.5 pb-2">
                      <Checkbox
                        id="cal-event-allday"
                        checked={eventAllDay}
                        onCheckedChange={(v) => setEventAllDay(v === true)}
                      />
                      <Label htmlFor="cal-event-allday" className="text-xs">
                        All day
                      </Label>
                    </div>
                    {!eventAllDay && (
                      <>
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="cal-event-start" className="text-xs">
                            Start
                          </Label>
                          <Input
                            id="cal-event-start"
                            type="time"
                            value={eventStartTime}
                            onChange={(e) => setEventStartTime(e.target.value)}
                            className="w-28"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="cal-event-end" className="text-xs">
                            End
                          </Label>
                          <Input
                            id="cal-event-end"
                            type="time"
                            value={eventEndTime}
                            onChange={(e) => setEventEndTime(e.target.value)}
                            placeholder="+1h"
                            className="w-28"
                          />
                        </div>
                      </>
                    )}
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="cal-event-desc" className="text-xs">
                        Description
                      </Label>
                      <Input
                        id="cal-event-desc"
                        value={eventDescription}
                        onChange={(e) => setEventDescription(e.target.value)}
                        placeholder="Optional"
                        className="w-48"
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={
                        eventBusy || !eventTitle.trim() || (!eventAllDay && !eventStartTime)
                      }
                    >
                      Add event
                    </Button>
                  </div>
                  {eventError && <p className="text-sm text-destructive">{eventError}</p>}
                </form>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
