import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSyncStatus } from "@/lib/sync/client";
import {
  applyBulkSyncAction,
  getSyncConfigView,
  setSyncEnabled,
} from "@/lib/sync/config";
import { TOGGLEABLE_CATEGORY_IDS } from "@/lib/sync/tables";

// Local settings endpoint for the /sync control center — reads/writes THIS
// device's sync_config. Not the host-serving endpoint (that's push/pull), so
// no Tailscale/token guard: it's the same trust level as /api/status, driven
// by the local UI. Every write is one row, so no batching.

function payload() {
  const db = getDb();
  return { sync: getSyncStatus(), categories: getSyncConfigView(db) };
}

export async function GET() {
  return NextResponse.json(payload());
}

// Single toggle. id is z.enum'd against the toggleable category ids — a
// hard-excluded or unknown id fails validation here with an explicit error,
// never a silent no-op that could read as success. This (not just UI
// omission) is what stops a hard-excluded category from ever being enabled.
const patchSchema = z.object({
  id: z.enum(TOGGLEABLE_CATEGORY_IDS),
  enabled: z.boolean(),
});

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const ok = setSyncEnabled(getDb(), parsed.data.id, parsed.data.enabled);
  if (!ok) {
    // Defense in depth: setSyncEnabled also refuses hard-excluded ids.
    return NextResponse.json({ error: `${parsed.data.id} is not a toggleable category` }, { status: 400 });
  }
  return NextResponse.json(payload());
}

// Bulk toolbar actions (Enable All / Disable All / Reset to Recommended).
const bulkSchema = z.object({ action: z.enum(["enable", "disable", "reset"]) });

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  applyBulkSyncAction(getDb(), parsed.data.action);
  return NextResponse.json(payload());
}
