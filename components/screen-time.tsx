"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { Card } from "@/components/ui/card";

// Screen-time card fed by the local ActivityWatch instance via
// /api/activity. Refreshes every 60s while mounted; AW not running shows
// a quiet hint, never an error wall.

type UsageItem = { name: string; seconds: number };
type Summary =
  | { available: false }
  | { available: true; totalSeconds: number; topApps: UsageItem[]; topDomains: UsageItem[] };

const POLL_MS = 60_000;

function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function ScreenTime() {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/activity");
        const data = (await res.json()) as Summary;
        if (!cancelled) setSummary(data);
      } catch {
        if (!cancelled) setSummary({ available: false });
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Window-watcher apps are the primary list; domains stand in when only
  // the browser extension is reporting.
  const top =
    summary && summary.available
      ? summary.topApps.length > 0
        ? summary.topApps
        : summary.topDomains
      : [];

  return (
    <Card className="h-full gap-3">
      <div className="flex items-start justify-between px-(--card-spacing)">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className="text-primary [&>svg]:size-3.5">
            <Timer />
          </span>
          Screen time
        </span>
        <span className="text-xs text-muted-foreground/70">today</span>
      </div>
      <div className="px-(--card-spacing)">
        {!summary && <p className="text-xs text-muted-foreground">checking…</p>}
        {summary && !summary.available && (
          <p className="text-xs text-muted-foreground">
            ActivityWatch isn&apos;t running (localhost:5600)
          </p>
        )}
        {summary?.available && (
          <>
            <p className="text-3xl leading-none font-semibold tracking-tight">
              {fmt(summary.totalSeconds)}
              <span className="ml-1 text-sm font-normal text-muted-foreground lowercase">
                active
              </span>
            </p>
            {top.length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
                {top.map((item) => (
                  <li key={item.name} className="flex justify-between gap-2">
                    <span className="truncate">{item.name}</span>
                    <span className="shrink-0 tabular-nums">{fmt(item.seconds)}</span>
                  </li>
                ))}
              </ul>
            )}
            {summary.topApps.length > 0 && summary.topDomains.length > 0 && (
              <p className="mt-1.5 truncate text-xs text-muted-foreground/70">
                sites: {summary.topDomains.map((d) => d.name).join(", ")}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
