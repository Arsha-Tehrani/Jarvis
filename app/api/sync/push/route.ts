import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { applyPush } from "@/lib/sync/core";
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
  const { stamped, fkMissing } = applyPush(getDb(), spec, parsed.data.rows, hostStamp());
  return NextResponse.json({ stamped, fkMissing });
}
