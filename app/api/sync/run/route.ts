import { NextResponse } from "next/server";
import { getSyncStatus, isSyncClientConfigured, runSyncPass, syncRole } from "@/lib/sync/client";

// Manual "Sync now" trigger for the client's 5-minute sync pass
// (lib/sync/client.ts's syncJob runs this same runSyncPass() on a cron, plus
// launch catch-up, plus a debounced push after writes). Client-only: the host
// runs no worker of its own — other devices pull its live jarvis.db directly —
// so there is nothing to "run" on a host. No confirm gate: a pass is an
// idempotent upsert-by-sync_id in both directions and never deletes.

export async function POST() {
  const role = syncRole();
  if (role === "disabled") {
    return NextResponse.json(
      { error: "Device sync is disabled — set SYNC_ROLE in .env.local." },
      { status: 409 }
    );
  }
  if (role === "host") {
    return NextResponse.json(
      { error: "This machine is the sync host; it serves other devices live and has no pass to run." },
      { status: 409 }
    );
  }
  if (!isSyncClientConfigured()) {
    return NextResponse.json(
      { error: "SYNC_HOST_URL / SYNC_AUTH_TOKEN not set." },
      { status: 409 }
    );
  }

  try {
    // runSyncPass swallows per-table failures (logs + retries next tick), so
    // this resolves even when the host is unreachable; the returned status
    // shows whether anything is still pending.
    await runSyncPass();
    return NextResponse.json({ ok: true, status: getSyncStatus() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 502 }
    );
  }
}
