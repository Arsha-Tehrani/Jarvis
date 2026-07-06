"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Live hardware card: polls /api/system every 8s while mounted (interval
// cleared on unmount). Visual language mirrors MetricCard.

type SystemStats = {
  cpu: { load: number; cores: number };
  memory: { used: number; total: number };
  disk: { used: number; size: number; mount: string } | null;
};

const POLL_MS = 8000;

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

function UsageBar({
  label,
  detail,
  percent,
}: {
  label: string;
  detail: string;
  percent: number;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{detail}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-secondary">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            clamped > 90 ? "bg-destructive" : "bg-primary"
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

export function SystemMonitor() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/system");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as SystemStats;
        if (!cancelled) {
          setStats(data);
          setOffline(false);
        }
      } catch {
        if (!cancelled) setOffline(true);
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <Card className="h-full gap-3">
      <div className="flex items-start justify-between px-(--card-spacing)">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className="text-primary [&>svg]:size-3.5">
            <Cpu />
          </span>
          System
        </span>
        <span className="text-xs text-muted-foreground/70">live</span>
      </div>
      <div className="flex flex-col gap-3 px-(--card-spacing) pb-1">
        {offline && <p className="text-xs text-muted-foreground">stats unavailable</p>}
        {!offline && !stats && <p className="text-xs text-muted-foreground">probing…</p>}
        {!offline && stats && (
          <>
            <UsageBar
              label="CPU"
              detail={`${stats.cpu.load}% · ${stats.cpu.cores} cores`}
              percent={stats.cpu.load}
            />
            <UsageBar
              label="Memory"
              detail={`${gb(stats.memory.used)} / ${gb(stats.memory.total)} GB`}
              percent={(stats.memory.used / stats.memory.total) * 100}
            />
            {stats.disk && (
              <UsageBar
                label={`Disk ${stats.disk.mount}`}
                detail={`${gb(stats.disk.used)} / ${gb(stats.disk.size)} GB`}
                percent={(stats.disk.used / stats.disk.size) * 100}
              />
            )}
          </>
        )}
      </div>
    </Card>
  );
}
