"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  eventDayKeys,
  eventTimeLabel,
  isAllDay,
  localDateKey,
  monthGrid,
  weekOf,
} from "@/lib/calendar-grid";

type CalEvent = {
  google_event_id: string;
  title: string;
  start: string;
  end: string;
  updated_at: string;
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"month" | "week">("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const load = useCallback(async () => {
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
  const lastPolled = events[0]?.updated_at;

  return (
    <div className="flex flex-col gap-6">
      {flag && (
        <p className="text-sm text-muted-foreground">
          {CALLBACK_MESSAGES[flag] ?? flag}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!configured ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Google OAuth is not configured. Set GOOGLE_CLIENT_ID and
            GOOGLE_CLIENT_SECRET in .env.local (OAuth client redirect:{" "}
            <code className="rounded bg-muted px-1">
              http://localhost:3000/api/google/callback
            </code>
            ), then connect here.
          </CardContent>
        </Card>
      ) : !connected ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6 text-sm">
            <p className="text-muted-foreground">
              Not connected. Google Calendar is the source of truth — Jarvis reads it
              back on open and hourly. Testing-mode tokens expire about weekly;
              reconnect here when that happens.
            </p>
            <div>
              <Button onClick={() => act("connect")} disabled={busy}>
                Connect Google Calendar
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
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
                      setSelectedDay(todayKey);
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
                  <Button variant="outline" size="sm" onClick={() => act("poll")} disabled={busy}>
                    Refresh
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => act("disconnect")} disabled={busy}>
                    Disconnect
                  </Button>
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
                  const outside = view === "month" && day.getMonth() !== cursorMonth;
                  const isToday = key === todayKey;
                  const shown = view === "month" ? dayEvents.slice(0, 3) : dayEvents;
                  const overflow = dayEvents.length - shown.length;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedDay(key)}
                      className={`flex flex-col items-stretch gap-1 bg-background p-1.5 text-left align-top transition-colors hover:bg-accent/50 ${
                        view === "month" ? "min-h-24" : "min-h-48"
                      } ${outside ? "opacity-40" : ""} ${
                        selectedDay === key ? "bg-accent/60" : ""
                      }`}
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
                      {shown.map((e) => (
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
                      {overflow > 0 && (
                        <span className="px-1 text-[10px] text-muted-foreground">
                          +{overflow} more
                        </span>
                      )}
                    </button>
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
              <CardContent>
                {selectedEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events this day.</p>
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
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
