import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getDeviceId } from "@/lib/sync/client";
import { getEnabledSyncTables } from "@/lib/sync/config";
import { serializePullRows } from "@/lib/sync/core";
import { requireSyncHost } from "@/lib/sync/host";
import { getSyncSpec, pullQuerySchema } from "@/lib/sync/tables";

// GET /api/sync/pull?table=X&since=<cursor> — host-only (see
// lib/sync/host.ts: Tailscale-only deployment assumption). Returns rows
// with a host-stamped updated_at newer than the cursor. The host's own
// rows are served straight from its live jarvis.db (backfilled with sync
// ids lazily here — the host runs no push worker of its own).

export async function GET(req: NextRequest) {
  const denied = requireSyncHost(req);
  if (denied) return denied;

  const params = req.nextUrl.searchParams;
  const parsed = pullQuerySchema.safeParse({
    table: params.get("table") ?? undefined,
    since: params.get("since") ?? undefined,
  });
  if (!parsed.success) {
    // Non-allowlisted tables die here (z.enum) with a clear error.
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }

  const spec = getSyncSpec(parsed.data.table);
  if (!spec) {
    return NextResponse.json({ error: `table ${parsed.data.table} is not syncable` }, { status: 400 });
  }
  const db = getDb();
  // The host only SERVES tables it has enabled. A disabled table returns an
  // empty page with a null cursor — the client advances nothing and simply
  // stops seeing rows for it.
  if (!getEnabledSyncTables(db).has(spec.table)) {
    return NextResponse.json({ rows: [], cursor: null });
  }
  const { rows, cursor } = serializePullRows(db, spec, getDeviceId(), parsed.data.since);
  return NextResponse.json({ rows, cursor });
}
