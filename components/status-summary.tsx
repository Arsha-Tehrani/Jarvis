"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import type { HealthSummary } from "@/lib/status-core";

// Compact Today-view card: "10/12 healthy" with a link into /status, so a
// broken integration is visible without leaving the home page. Polls the
// (server-cached) status endpoint every 60s while mounted.

const POLL_MS = 60_000;

export function StatusSummary() {
  const [summary, setSummary] = useState<HealthSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { summary: HealthSummary };
        if (!cancelled) setSummary(data.summary);
      } catch {
        if (!cancelled) setSummary(null);
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
    <MetricCard
      href="/status"
      label="Status"
      icon={<ShieldCheck />}
      hero={summary ? `${summary.healthy}/${summary.configured}` : "—"}
      unit="healthy"
      sub={
        !summary
          ? "checking integrations…"
          : summary.problems.length > 0
            ? `issue: ${summary.problems.slice(0, 2).join(", ")}`
            : "all configured integrations up"
      }
    />
  );
}
