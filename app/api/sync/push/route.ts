import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { applyPush } from "@/lib/sync/core";
import { getEnabledSyncTables } from "@/lib/sync/config";
import { hostStamp, requireSyncHost } from "@/lib/sync/host";
import { getSyncSpec, pushBodySchema } from "@/lib/sync/tables";

// POST /api/sync/push — host-only (see lib/sync/host.ts: Tailscale-only
// deployment assumption). Upserts each row by sync_id and stamps
// updated_at with THIS server's clock at receipt, overwriting whatever the
// client sent — receipt order at the host is the one conflict clock, so
// device clock skew can never reorder writes.

export async function POST(req: NextRequest) {
  const denied = requireSyncHost(req);
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = pushBodySchema.safeParse(body);
  if (!parsed.success) {
    // Includes any non-allowlisted table name: z.enum rejects it here with
    // an explicit error — never silently ignored, never queried.
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }

  const spec = getSyncSpec(parsed.data.table);
  if (!spec) {
    return NextResponse.json({ error: `table ${parsed.data.table} is not syncable` }, { status: 400 });
  }
  const db = getDb();
  // The host only ACCEPTS rows for tables it itself has enabled. A client with
  // a stale toggle shouldn't break the whole sync tick, so a disabled table is
  // a silent drop (nothing stamped → the client keeps those rows dirty and
  // stops resending once it, too, sees the table disabled), not a hard error.
  if (!getEnabledSyncTables(db).has(spec.table)) {
    return NextResponse.json({ stamped: [], fkMissing: 0 });
  }
  const { stamped, fkMissing } = applyPush(db, spec, parsed.data.rows, hostStamp());
  return NextResponse.json({ stamped, fkMissing });
}
