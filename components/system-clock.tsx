"use client";

import { useEffect, useRef, useState } from "react";
import { zoneAbbreviation } from "@/lib/clock";
import { cn } from "@/lib/utils";

// Always-visible server clock: what date/time Jarvis is actually running at
// and logging against. Sourced from GET /api/system/clock (the same process
// running the cron scheduler), synced once on mount and every 60s to correct
// drift, ticking locally once per second in between so the route isn't
// hammered. Before the first sync (or if the route is unreachable) it shows
// the browser clock, labeled as such — never a blank.

const SYNC_MS = 60_000;

type ClockSync = {
  // serverNow - clientNow at sync time; applied to Date.now() each tick.
  offsetMs: number;
  timezone: string;
  offsetMinutes: number;
};

export function SystemClock({ className }: { className?: string }) {
  const [sync, setSync] = useState<ClockSync | null>(null);
  // null until mounted — the server render has no stable "now" (hydration).
  const [nowMs, setNowMs] = useState<number | null>(null);
  const syncRef = useRef<ClockSync | null>(null);
  syncRef.current = sync;

  useEffect(() => {
    let cancelled = false;
    async function syncClock() {
      try {
        const res = await fetch("/api/system/clock");
        if (!res.ok) return; // keep last sync (or browser fallback)
        const body = (await res.json()) as {
          now: string;
          timezone: string;
          offsetMinutes: number;
        };
        if (cancelled) return;
        setSync({
          offsetMs: Date.parse(body.now) - Date.now(),
          timezone: body.timezone,
          offsetMinutes: body.offsetMinutes,
        });
      } catch {
        // server unreachable — the browser-clock fallback keeps ticking
      }
    }
    void syncClock();
    setNowMs(Date.now());
    const syncId = setInterval(() => void syncClock(), SYNC_MS);
    const tickId = setInterval(
      () => setNowMs(Date.now() + (syncRef.current?.offsetMs ?? 0)),
      1000
    );
    return () => {
      cancelled = true;
      clearInterval(syncId);
      clearInterval(tickId);
    };
  }, []);

  if (nowMs == null) return null; // pre-hydration

  const date = new Date(nowMs);
  const timeZone = sync?.timezone;
  const opts = timeZone ? { timeZone } : {};
  const dayLabel = new Intl.DateTimeFormat("en-US", {
    ...opts,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  const timeLabel = new Intl.DateTimeFormat("en-US", {
    ...opts,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
  const zone = sync
    ? zoneAbbreviation(date, sync.timezone, sync.offsetMinutes)
    : zoneAbbreviation(date, Intl.DateTimeFormat().resolvedOptions().timeZone, -date.getTimezoneOffset());

  return (
    <span
      className={cn("text-sm tabular-nums text-muted-foreground", className)}
      title={
        sync
          ? `Server clock (${sync.timezone}) — what cron jobs and "today" defaults run against`
          : "Browser clock — server clock not reachable yet"
      }
    >
      {dayLabel} · {timeLabel} {zone}
      {!sync && " (browser)"}
    </span>
  );
}
