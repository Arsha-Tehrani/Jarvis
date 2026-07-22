"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { SyncStatus, SyncTableMark } from "@/lib/sync/client";
import type { SyncCategoryView } from "@/lib/sync/config";
import type { SyncDomain } from "@/lib/sync/tables";

// The Sync Control Center (/sync). Every data category Jarvis has, grouped by
// domain, each with a live toggle. Where /status shows a compact summary, this
// is the full picture: currently-off categories become toggleable (single
// person, own devices, private Tailscale mesh), a few stay permanently locked
// (syncing them would break the app), and bulk actions flip the rest at once.

type ConfigPayload = { sync: SyncStatus; categories: SyncCategoryView[] };

const DOMAIN_ORDER: SyncDomain[] = ["life", "money", "knowledge", "system"];
const DOMAIN_LABEL: Record<SyncDomain, string> = {
  life: "Life tracking",
  money: "Money",
  knowledge: "Knowledge",
  system: "System",
};

function timeOf(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "never";
}

// Aggregate the per-table marks (/status computes them per raw table) up to the
// category the /sync page renders.
function markFor(tables: string[], marks: SyncTableMark[]) {
  const rows = marks.filter((m) => tables.includes(m.table));
  if (rows.length === 0) return null;
  const pending = rows.reduce((n, r) => n + r.pending, 0);
  const maxIso = (get: (r: SyncTableMark) => string | null) =>
    rows.map(get).filter(Boolean).sort().at(-1) ?? null;
  return { pending, lastPushAt: maxIso((r) => r.lastPushAt), lastPullAt: maxIso((r) => r.lastPullAt) };
}

export function SyncView() {
  const [data, setData] = useState<ConfigPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/config");
      if (!res.ok) throw new Error();
      setData((await res.json()) as ConfigPayload);
      setError(null);
    } catch {
      setError("Couldn't load sync settings.");
    }
  }, []);

  // Poll so pending counts / last-synced marks stay current while open.
  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // Optimistic single toggle: flip locally, PATCH, revert on failure.
  async function toggle(id: string, next: boolean) {
    if (!data) return;
    const prev = data;
    setData({
      ...data,
      categories: data.categories.map((c) => (c.id === id ? { ...c, enabled: next } : c)),
    });
    try {
      const res = await fetch("/api/sync/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled: next }),
      });
      if (!res.ok) throw new Error();
      setData((await res.json()) as ConfigPayload);
    } catch {
      setData(prev); // revert
      setError("Couldn't save that change — reverted.");
    }
  }

  async function bulk(action: "enable" | "disable" | "reset") {
    setBusy(true);
    try {
      const res = await fetch("/api/sync/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error();
      setData((await res.json()) as ConfigPayload);
      setError(null);
    } catch {
      setError("Bulk action failed.");
    } finally {
      setBusy(false);
    }
  }

  const sync = data?.sync;
  const marks = sync?.tables ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Sync</h1>
        <p className="text-sm text-muted-foreground">
          Choose what this device sends and receives. Each machine keeps its own settings — for a
          two-device setup, match them on both.
        </p>
      </div>

      {/* Connection / topology card — same data source as /status. */}
      <ConnectionCard sync={sync} />

      {/* Toolbar + the "off never deletes" reassurance. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk("enable")}>
            Enable all
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk("disable")}>
            Disable all
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => bulk("reset")}>
            Reset to recommended
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Turning a category off never deletes local data — it only pauses future sync for it.
          Everything already synced stays exactly where it is on every device.
        </p>
        {error && <p className="text-xs text-warn">{error}</p>}
      </div>

      {!data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        DOMAIN_ORDER.map((domain) => {
          const rows = data.categories.filter((c) => c.domain === domain);
          if (rows.length === 0) return null;
          return (
            <section key={domain} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold tracking-tight">{DOMAIN_LABEL[domain]}</h2>
              <Card className="gap-0 px-0 py-0">
                {rows.map((cat, i) => (
                  <CategoryRow
                    key={cat.id}
                    cat={cat}
                    mark={cat.enabled ? markFor(cat.tables, marks) : null}
                    roleActive={sync?.role !== "disabled" && !!sync?.configured}
                    onToggle={(next) => toggle(cat.id, next)}
                    divider={i > 0}
                  />
                ))}
              </Card>
            </section>
          );
        })
      )}
    </div>
  );
}

function ConnectionCard({ sync }: { sync: SyncStatus | undefined }) {
  if (!sync || sync.role === "disabled") {
    return (
      <Card className="px-(--card-spacing)">
        <p className="text-xs text-muted-foreground">
          Device sync is disabled — set SYNC_ROLE (host/client) in .env.local to turn it on. You can
          still choose categories below; they take effect once sync is enabled.
        </p>
      </Card>
    );
  }
  return (
    <Card className="gap-2 px-(--card-spacing)">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={cn("size-2.5 shrink-0 rounded-full", sync.configured ? "bg-emerald-500" : "bg-warn")}
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
        </p>
      )}
    </Card>
  );
}

function CategoryRow({
  cat,
  mark,
  roleActive,
  onToggle,
  divider,
}: {
  cat: SyncCategoryView;
  mark: { pending: number; lastPushAt: string | null; lastPullAt: string | null } | null;
  roleActive: boolean;
  onToggle: (next: boolean) => void;
  divider: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 px-(--card-spacing) py-3",
        divider && "border-t border-border"
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          {cat.hardExcluded && <Lock className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
          <span className={cn("text-sm font-medium", cat.hardExcluded && "text-muted-foreground")}>
            {cat.label}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{cat.description}</span>
        {cat.risk && <span className="text-xs text-warn">⚠ {cat.risk}</span>}
        {cat.hardExcluded && cat.lockedReason && (
          <span className="text-xs text-muted-foreground/80 italic">{cat.lockedReason}</span>
        )}
        {cat.enabled && roleActive && mark && (
          <span className="text-xs text-muted-foreground">
            {mark.pending > 0 && <span className="text-warn">{mark.pending} pending · </span>}
            push {timeOf(mark.lastPushAt)} · pull {timeOf(mark.lastPullAt)}
          </span>
        )}
      </div>
      <div className="shrink-0 pt-0.5">
        {cat.hardExcluded ? (
          <Lock className="size-4 text-muted-foreground/50" aria-label="Locked — cannot sync" />
        ) : (
          <Toggle checked={cat.enabled} onChange={onToggle} label={cat.label} />
        )}
      </div>
    </div>
  );
}

// Minimal dependency-free switch (no Radix in this project) matching how other
// single-setting toggles in the app behave: persists immediately via onChange.
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`Sync ${label}`}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-emerald-500" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "inline-block size-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
