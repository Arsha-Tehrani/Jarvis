"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { HealthCheck, HealthSummary } from "@/lib/status-core";
import type { SyncStatus } from "@/lib/sync/client";

// Status grid: one card per integration, polled every 30s while mounted
// (server-side the checks are cached ~20s, so polling stays cheap). The
// refresh button forces a fresh probe pass with ?fresh=1.

const POLL_MS = 30_000;

const DOT: Record<HealthCheck["status"], string> = {
  ok: "bg-emerald-500",
  degraded: "bg-yellow-500",
  down: "bg-destructive",
  unconfigured: "bg-muted-foreground/40",
};

const STATUS_LABEL: Record<HealthCheck["status"], string> = {
  ok: "ok",
  degraded: "degraded",
  down: "down",
  unconfigured: "not configured",
};

type StatusPayload = { checks: HealthCheck[]; summary: HealthSummary; sync?: SyncStatus };

type SidecarStatus = {
  id: string;
  label: string;
  kind: "bundled" | "third-party";
  port?: number;
  state: "stopped" | "starting" | "running" | "crashed" | "not-installed";
  readiness?: "not-set-up" | "incomplete" | "ready";
  missingPackages?: string[];
  settingUp?: boolean;
  hint?: string;
  hintKind?: "missing-dep" | "port-in-use";
  installUrl?: string;
  pid?: number;
  uptimeSec?: number;
  exitCode?: number | null;
};

export function StatusView() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [sidecars, setSidecars] = useState<Map<string, SidecarStatus>>(new Map());
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (fresh: boolean) => {
    try {
      const [statusRes, sidecarRes] = await Promise.all([
        fetch(`/api/status${fresh ? "?fresh=1" : ""}`),
        fetch("/api/sidecars"),
      ]);
      if (!statusRes.ok) throw new Error();
      setData((await statusRes.json()) as StatusPayload);
      if (sidecarRes.ok) {
        const body = (await sidecarRes.json()) as { sidecars: SidecarStatus[] };
        setSidecars(new Map(body.sidecars.map((s) => [s.id, s])));
      }
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load(false);
    const id = setInterval(() => load(false), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // While a setup or launch is in flight, poll just the (cheap) sidecar
  // endpoint faster so the card flips without waiting for the 30s tick.
  const settingUpAny = [...sidecars.values()].some(
    (s) => s.settingUp || s.state === "starting"
  );
  useEffect(() => {
    if (!settingUpAny) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/sidecars");
        if (!res.ok) return;
        const body = (await res.json()) as { sidecars: SidecarStatus[] };
        setSidecars(new Map(body.sidecars.map((s) => [s.id, s])));
      } catch {
        /* next tick */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [settingUpAny]);

  async function refresh() {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">System status</h1>
          <p className="text-xs text-muted-foreground">
            {data
              ? `${data.summary.healthy}/${data.summary.configured} configured integrations healthy · ${
                  data.checks.length - data.summary.configured
                } not configured`
              : error
                ? "status unavailable"
                : "probing…"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/network-log" className="action-link text-xs">
            Network log
          </Link>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.checks ?? []).map((check) => (
          <Card key={check.id} className="gap-2 px-(--card-spacing)">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span
                  className={cn("size-2.5 shrink-0 rounded-full", DOT[check.status])}
                  aria-hidden
                />
                {check.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {STATUS_LABEL[check.status]}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{check.message}</p>
            <p className="text-xs text-muted-foreground/70">
              {check.latencyMs != null && `${check.latencyMs}ms · `}
              checked{" "}
              {new Date(check.lastChecked).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })}
            </p>
            {sidecars.has(check.id) && (
              <SidecarControls
                sidecar={sidecars.get(check.id)!}
                onChanged={() => load(true)}
              />
            )}
          </Card>
        ))}
      </div>
      {data?.sync && <SyncSection sync={data.sync} />}
    </div>
  );
}

// Controls for the in-repo sidecars AND (best-effort) ActivityWatch. The
// contract: every state shows exactly one primary action — Set up, Start,
// or Stop — or a plain-language reason with a way forward (install link).
// Never a disabled button with no explanation.
function SidecarControls({
  sidecar,
  onChanged,
}: {
  sidecar: SidecarStatus;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);

  const needsSetup =
    sidecar.kind === "bundled" &&
    (sidecar.readiness === "not-set-up" ||
      sidecar.readiness === "incomplete" ||
      // A missing-dep crash re-offers Set up even if the last readiness
      // check predates the crash.
      (sidecar.state === "crashed" && sidecar.hintKind === "missing-dep"));

  // Plain-language status line: say what's wrong and what fixes it.
  let statusLine: string;
  if (sidecar.settingUp) {
    statusLine = "setting up — installing into its own .venv (watch logs)";
  } else if (sidecar.state === "not-installed") {
    statusLine = "not installed — ActivityWatch is a separate app";
  } else if (sidecar.readiness === "not-set-up") {
    statusLine = "Setup needed — no environment found.";
  } else if (sidecar.readiness === "incomplete") {
    statusLine = `Setup needed — missing package: ${
      sidecar.missingPackages?.join(", ") ?? "(couldn't read the list — see logs)"
    }`;
  } else {
    statusLine = [
      sidecar.state,
      sidecar.pid != null ? `pid ${sidecar.pid}` : null,
      sidecar.uptimeSec != null ? `up ${formatUptime(sidecar.uptimeSec)}` : null,
      sidecar.state === "crashed" && sidecar.exitCode != null
        ? `exit ${sidecar.exitCode}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  async function act(action: "start" | "stop" | "setup") {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/sidecars/${sidecar.id}/${action}`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(body?.error ?? `${action} failed (${res.status})`);
      }
      if (action === "setup") setShowLogs(true); // the log stream IS the progress UI
    } catch {
      setActionError(`${action} request failed`);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const loadLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/sidecars/${sidecar.id}/logs`);
      const body = (await res.json()) as { lines: string[]; note?: string };
      setLogs(body.note ? [body.note] : body.lines);
    } catch {
      setLogs(["(logs unavailable)"]);
    }
  }, [sidecar.id]);

  // Stream-ish: refresh the open log panel while setup/startup is running.
  useEffect(() => {
    if (!showLogs) return;
    loadLogs();
    if (!sidecar.settingUp && sidecar.state !== "starting") return;
    const id = setInterval(loadLogs, 2000);
    return () => clearInterval(id);
  }, [showLogs, sidecar.settingUp, sidecar.state, loadLogs]);

  // Exactly one primary action per state.
  let primary: ReactNode;
  if (sidecar.settingUp) {
    primary = (
      <Button size="sm" disabled>
        Setting up…
      </Button>
    );
  } else if (sidecar.state === "not-installed") {
    primary = (
      <a
        href={sidecar.installUrl ?? "https://activitywatch.net/"}
        target="_blank"
        rel="noreferrer"
        className="action-link text-xs"
      >
        Install ActivityWatch
      </a>
    );
  } else if (sidecar.state === "running" || sidecar.state === "starting") {
    primary = (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => act("stop")}>
        Stop
      </Button>
    );
  } else if (needsSetup) {
    primary = (
      <Button size="sm" disabled={busy} onClick={() => act("setup")}>
        Set up
      </Button>
    );
  } else {
    primary = (
      <Button size="sm" disabled={busy} onClick={() => act("start")}>
        Start
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 text-xs text-muted-foreground">{statusLine}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setShowLogs(!showLogs)} className="action-link text-xs">
            {showLogs ? "hide logs" : "logs"}
          </button>
          {primary}
        </span>
      </div>
      {sidecar.hint && !sidecar.settingUp && (
        <p className="text-xs font-medium text-yellow-700 dark:text-yellow-500">{sidecar.hint}</p>
      )}
      {actionError && <p className="text-xs text-destructive">{actionError}</p>}
      {showLogs && (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-[10px] leading-relaxed whitespace-pre-wrap">
          {logs === null ? "loading…" : logs.length > 0 ? logs.join("\n") : "(no output captured yet)"}
        </pre>
      )}
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

// The Sync section: role + per-table push/pull marks and pending counts.
// Same card language as the checks above; "disabled" is a calm one-liner.
function SyncSection({ sync }: { sync: SyncStatus }) {
  const timeOf = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "never";

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold tracking-tight">Sync</h2>
      {sync.role === "disabled" ? (
        <Card className="px-(--card-spacing)">
          <p className="text-xs text-muted-foreground">
            Device sync is disabled — set SYNC_ROLE (host/client) in .env.local to enable it.
            Only allowlisted tracker tables ever sync; finance, mail, and notes stay local.
          </p>
        </Card>
      ) : (
        <Card className="gap-3 px-(--card-spacing)">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                sync.configured ? "bg-emerald-500" : "bg-yellow-500"
              )}
              aria-hidden
            />
            <span className="font-medium">
              {sync.role === "host" ? "Host" : "Client"}
            </span>
            <span className="text-muted-foreground">
              {sync.role === "host"
                ? sync.configured
                  ? "serving push/pull for other devices (Tailscale-only endpoint)"
                  : "SYNC_AUTH_TOKEN not set — refusing to serve"
                : sync.configured
                  ? `syncing with ${sync.hostUrl}`
                  : "SYNC_HOST_URL / SYNC_AUTH_TOKEN not set"}
              {sync.deviceId && ` · device ${sync.deviceId.slice(0, 8)}`}
            </span>
          </div>
          {sync.tables && (
            <div className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
              {sync.tables.map((t) => (
                <div key={t.table} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="font-mono">{t.table}</span>
                  <span className="text-muted-foreground">
                    {t.pending > 0 && (
                      <span className="text-yellow-600 dark:text-yellow-500">
                        {t.pending} pending ·{" "}
                      </span>
                    )}
                    {sync.role === "client"
                      ? `push ${timeOf(t.lastPushAt)} · pull ${timeOf(t.lastPullAt)}`
                      : "served live"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
