import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { loggedFetch } from "@/lib/network-log";
import { applyPull, collectPending, markPushed } from "@/lib/sync/core";
import { SYNC_TABLES, pullRowSchema } from "@/lib/sync/tables";
import { z } from "zod";

// Client half of selective sync (SYNC_ROLE=client). Pushes locally-dirty
// rows to the host and pulls everyone's rows back, per allowlisted table,
// on a cron tick (plus a debounced nudge right after app writes). With
// SYNC_ROLE unset this whole module is inert: every entry point returns
// immediately, no network calls, no timers.
//
// Failure model mirrors GoodNotes sync: cursors and dirty flags move ONLY
// after a confirmed success; an unreachable host is logged (through the
// network audit log — sync traffic is outbound and should be visible on
// /network-log) and simply retried next tick. Every push/pull is
// upsert-by-sync_id, so repeats are always safe.

export type SyncRole = "host" | "client" | "disabled";

export function syncRole(): SyncRole {
  const role = process.env.SYNC_ROLE;
  if (role === "host" || role === "client") return role;
  return "disabled";
}

export function isSyncClientConfigured(): boolean {
  return (
    syncRole() === "client" &&
    !!process.env.SYNC_HOST_URL &&
    !!process.env.SYNC_AUTH_TOKEN
  );
}

// Stable per-machine identity: DEVICE_ID env wins; otherwise generate a
// UUID once and persist it in device_meta (excluded from backups so a
// restore can't clone another machine's identity).
export function getDeviceId(): string {
  if (process.env.DEVICE_ID) return process.env.DEVICE_ID;
  const db = getDb();
  const row = db.prepare("SELECT value FROM device_meta WHERE key = 'device_id'").get() as
    | { value: string }
    | undefined;
  if (row) return row.value;
  const generated = randomUUID();
  db.prepare("INSERT INTO device_meta (key, value) VALUES ('device_id', ?)").run(generated);
  return generated;
}

const pullResponseSchema = z.object({
  rows: z.array(pullRowSchema),
  cursor: z.string().nullable(),
});

const pushResponseSchema = z.object({
  stamped: z.array(z.object({ sync_id: z.string(), updated_at: z.string() })),
});

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.SYNC_AUTH_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function setSyncState(table: string, patch: Partial<Record<"pull_cursor" | "last_pull_at" | "last_push_at", string>>): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sync_state (table_name, pull_cursor, last_pull_at, last_push_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(table_name) DO UPDATE SET
       pull_cursor = COALESCE(excluded.pull_cursor, sync_state.pull_cursor),
       last_pull_at = COALESCE(excluded.last_pull_at, sync_state.last_pull_at),
       last_push_at = COALESCE(excluded.last_push_at, sync_state.last_push_at)`
  ).run(table, patch.pull_cursor ?? null, patch.last_pull_at ?? null, patch.last_push_at ?? null);
}

function getSyncState(table: string):
  | { pull_cursor: string | null; last_pull_at: string | null; last_push_at: string | null }
  | undefined {
  return getDb()
    .prepare("SELECT pull_cursor, last_pull_at, last_push_at FROM sync_state WHERE table_name = ?")
    .get(table) as
    | { pull_cursor: string | null; last_pull_at: string | null; last_push_at: string | null }
    | undefined;
}

async function pushTable(table: (typeof SYNC_TABLES)[number], deviceId: string): Promise<void> {
  const db = getDb();
  const rows = collectPending(db, table, deviceId);
  if (rows.length === 0) return;
  const res = await loggedFetch(
    `${process.env.SYNC_HOST_URL}/api/sync/push`,
    { method: "POST", headers: authHeaders(), body: JSON.stringify({ table: table.table, rows }) },
    { feature: "sync-push", purpose: `push ${table.table}` }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`push ${table.table} → ${res.status}: ${detail.slice(0, 200)}`);
  }
  const parsed = pushResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error(`push ${table.table}: malformed host response`);
  // Confirmed success only: adopt host stamps, clear dirty flags.
  markPushed(db, table, parsed.data.stamped);
  setSyncState(table.table, { last_push_at: new Date().toISOString() });
}

async function pullTable(table: (typeof SYNC_TABLES)[number]): Promise<void> {
  const db = getDb();
  const since = getSyncState(table.table)?.pull_cursor ?? undefined;
  const params = new URLSearchParams({ table: table.table });
  if (since) params.set("since", since);
  const res = await loggedFetch(
    `${process.env.SYNC_HOST_URL}/api/sync/pull?${params}`,
    { headers: authHeaders() },
    { feature: "sync-pull", purpose: `pull ${table.table}` }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`pull ${table.table} → ${res.status}: ${detail.slice(0, 200)}`);
  }
  const parsed = pullResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error(`pull ${table.table}: malformed host response`);

  const { fkMissing } = applyPull(db, table, parsed.data.rows);
  // Hold the cursor if any row couldn't resolve its FK yet (its habit is
  // still in flight) — the whole page re-pulls next tick, idempotently.
  if (fkMissing === 0 && parsed.data.cursor) {
    setSyncState(table.table, { pull_cursor: parsed.data.cursor, last_pull_at: new Date().toISOString() });
  } else {
    setSyncState(table.table, { last_pull_at: new Date().toISOString() });
    if (fkMissing > 0) {
      console.warn(`[sync] ${table.table}: ${fkMissing} row(s) waiting on a referenced row — cursor held`);
    }
  }
}

// One full sync pass: push then pull, table by table (habits before
// habit_logs — the allowlist order is load-bearing for the FK).
export async function runSyncPass(pushOnly = false): Promise<void> {
  const deviceId = getDeviceId();
  for (const table of SYNC_TABLES) {
    try {
      await pushTable(table, deviceId);
      if (!pushOnly) await pullTable(table);
    } catch (err) {
      // Host unreachable/misconfigured is a normal state: log, move on,
      // retry on the next cron tick. Never bubbles out of the worker.
      console.error(`[sync] ${table.table} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

// Cron job (same pattern as every other job: interval + launch catch-up).
export async function syncJob(): Promise<void> {
  if (syncRole() !== "client") return; // host serves; disabled is inert
  if (!isSyncClientConfigured()) {
    console.log("[sync] SYNC_ROLE=client but SYNC_HOST_URL / SYNC_AUTH_TOKEN not set — skipping");
    return;
  }
  await runSyncPass();
}

// Debounced push nudge for write paths: cheap to call anywhere, coalesces
// bursts (e.g. an agent turn logging three things) into one push a few
// seconds later, and never blocks the caller on network I/O.
const globalForSync = globalThis as unknown as {
  __jarvisSyncPushTimer?: ReturnType<typeof setTimeout>;
  __jarvisSyncPassRunning?: boolean;
};

const PUSH_DEBOUNCE_MS = 3000;

export function queueSyncPush(): void {
  if (!isSyncClientConfigured()) return;
  if (globalForSync.__jarvisSyncPushTimer) clearTimeout(globalForSync.__jarvisSyncPushTimer);
  globalForSync.__jarvisSyncPushTimer = setTimeout(() => {
    globalForSync.__jarvisSyncPushTimer = undefined;
    if (globalForSync.__jarvisSyncPassRunning) return; // cron tick already at it
    globalForSync.__jarvisSyncPassRunning = true;
    runSyncPass(true)
      .catch((err) => console.error("[sync] queued push failed:", err))
      .finally(() => {
        globalForSync.__jarvisSyncPassRunning = false;
      });
  }, PUSH_DEBOUNCE_MS);
  // Don't keep the process alive just for a pending push.
  globalForSync.__jarvisSyncPushTimer.unref?.();
}

// ---- /status section -----------------------------------------------------

export type SyncStatus = {
  role: SyncRole;
  configured: boolean;
  deviceId?: string;
  hostUrl?: string;
  tables?: Array<{
    table: string;
    pending: number;
    lastPushAt: string | null;
    lastPullAt: string | null;
  }>;
};

export function getSyncStatus(): SyncStatus {
  const role = syncRole();
  if (role === "disabled") return { role, configured: false };
  const db = getDb();
  const tables = SYNC_TABLES.map((spec) => {
    const pending = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE sync_dirty = 1`).get() as {
        n: number;
      }
    ).n;
    const state = getSyncState(spec.table);
    return {
      table: spec.table,
      pending,
      lastPushAt: state?.last_push_at ?? null,
      lastPullAt: state?.last_pull_at ?? null,
    };
  });
  return {
    role,
    configured: role === "host" ? !!process.env.SYNC_AUTH_TOKEN : isSyncClientConfigured(),
    deviceId: getDeviceId(),
    hostUrl: role === "client" ? process.env.SYNC_HOST_URL : undefined,
    tables,
  };
}
