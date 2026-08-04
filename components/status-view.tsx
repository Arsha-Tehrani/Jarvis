"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SystemClock } from "@/components/system-clock";
import { cn } from "@/lib/utils";
import type { HealthCheck, HealthSummary } from "@/lib/status-core";
import type { SyncStatus } from "@/lib/sync/client";

// Status grid: one card per integration, polled every 30s while mounted
// (server-side the checks are cached ~20s, so polling stays cheap). The
// refresh button forces a fresh probe pass with ?fresh=1.

const POLL_MS = 30_000;

const DOT: Record<HealthCheck["status"], string> = {
  ok: "bg-emerald-500",
  degraded: "bg-warn/60",
  down: "bg-warn",
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
          {/* Cron-timing questions get debugged here — pair "what time does
              the server think it is" with the integration checks. */}
          <SystemClock />
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
            {check.id === "google-drive" && check.status === "ok" && <GoodNotesSyncButton />}
          </Card>
        ))}
      </div>
      {data?.sync && <SyncSection sync={data.sync} onSynced={() => load(true)} />}
    </div>
  );
}

// Manual trigger for the hourly GoodNotes->Drive->RAG poll (lib/goodnotes.ts),
// which otherwise only runs on its own schedule + launch catch-up. Shown
// next to Google Drive since that's the dependency GoodNotes sync needs.
function GoodNotesSyncButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function syncNow() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/goodnotes/sync", { method: "POST" });
      const body = await res.json();
      setResult(
        res.ok
          ? `${body.ingested} ingested, ${body.skipped} unchanged of ${body.scanned} scanned` +
              (body.failed?.length ? `, ${body.failed.length} failed` : "")
          : (body.error ?? "Sync failed")
      );
    } catch {
      setResult("Could not reach the app's API.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={syncNow} className="self-start">
        {busy ? "Syncing…" : "Sync GoodNotes now"}
      </Button>
      {result && <p className="text-xs text-muted-foreground">{result}</p>}
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
  const [reingestPath, setReingestPath] = useState("");
  const [reingestResult, setReingestResult] = useState<string | null>(null);

  // Manual re-ingest: the sidecar's /ingest is already idempotent (replaces
  // rather than duplicates a book's chunks), so this is just a UI trigger
  // for it — no confirm gate needed, nothing is deleted or overwritten
  // destructively.
  async function reingestTextbook() {
    if (!reingestPath.trim()) return;
    setBusy(true);
    setReingestResult(null);
    try {
      const res = await fetch("/api/textbook/reingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: reingestPath.trim() }),
      });
      const body = await res.json();
      setReingestResult(
        res.ok
          ? `Ingested ${body.chunks} chunk(s) from ${body.source} (${body.collection_total} total in the collection).`
          : (body.error ?? "Re-ingest failed")
      );
    } catch {
      setReingestResult("Could not reach the app's API.");
    } finally {
      setBusy(false);
    }
  }

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
        <p className="text-xs font-medium text-warn">{sidecar.hint}</p>
      )}
      {actionError && <p className="text-xs text-destructive">{actionError}</p>}
      {showLogs && (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-[10px] leading-relaxed whitespace-pre-wrap">
          {logs === null ? "loading…" : logs.length > 0 ? logs.join("\n") : "(no output captured yet)"}
        </pre>
      )}
      {sidecar.id === "textbook-rag" && sidecar.state === "running" && (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Absolute path to a book (.pdf/.md/.txt) to re-ingest"
              value={reingestPath}
              onChange={(e) => setReingestPath(e.target.value)}
              className="min-w-64 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs"
            />
            <Button size="sm" variant="outline" disabled={busy || !reingestPath.trim()} onClick={reingestTextbook}>
              Re-ingest
            </Button>
          </div>
          {reingestResult && <p className="text-xs text-muted-foreground">{reingestResult}</p>}
        </div>
      )}
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

// Manual "Sync now" for a configured client — runs the same runSyncPass() the
// 5-minute cron does, then refreshes the status so the per-table push/pull
// marks and pending counts update in place.
function SyncNowButton({ onSynced }: { onSynced: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function syncNow() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/sync/run", { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; error?: string; status?: SyncStatus };
      if (res.ok) {
        const pending = (body.status?.tables ?? []).reduce((n, t) => n + t.pending, 0);
        setResult(
          pending > 0
            ? `Synced — ${pending} row(s) still pending, will retry next tick.`
            : "Synced — up to date."
        );
        onSynced();
      } else {
        setResult(body.error ?? "Sync failed");
      }
    } catch {
      setResult("Could not reach the app's API.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={syncNow} className="self-start">
        {busy ? "Syncing…" : "Sync now"}
      </Button>
      {result && <p className="text-xs text-muted-foreground">{result}</p>}
    </div>
  );
}

// Compact Sync summary: role + health + "N of M categories syncing", with a
// link into /sync (the full control center). The per-category toggles and
// per-table marks live on /sync now — this page just surfaces state.
function SyncSection({ sync, onSynced }: { sync: SyncStatus; onSynced: () => void }) {
  const totalPending = (sync.tables ?? [])
    .filter((t) => t.enabled)
    .reduce((n, t) => n + t.pending, 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Sync</h2>
        <Link href="/sync" className="text-xs text-muted-foreground hover:text-foreground">
          Manage sync →
        </Link>
      </div>
      {sync.role === "disabled" ? (
        <Card className="px-(--card-spacing)">
          <p className="text-xs text-muted-foreground">
            Device sync is disabled — set SYNC_ROLE (host/client) in .env.local to enable it.
            Choose what syncs on the{" "}
            <Link href="/sync" className="underline hover:text-foreground">
              Sync page
            </Link>
            .
          </p>
        </Card>
      ) : (
        <Card className="gap-2 px-(--card-spacing)">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                sync.configured ? "bg-emerald-500" : "bg-warn"
              )}
              aria-hidden
            />
            <span className="font-medium">{sync.role === "host" ? "Host" : "Client"}</span>
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
          {sync.categories && (
            <p className="text-xs text-muted-foreground">
              {sync.categories.enabled} of {sync.categories.total} categories syncing
              {totalPending > 0 && <span className="text-warn"> · {totalPending} pending</span>}
            </p>
          )}
          {sync.role === "client" && sync.configured && <SyncNowButton onSynced={onSynced} />}
        </Card>
      )}
    </div>
  );
}
