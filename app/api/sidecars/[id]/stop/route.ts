import { NextResponse } from "next/server";
import { z } from "zod";
import { stopById } from "@/lib/sidecars/manager";
import { SIDECAR_IDS } from "@/lib/sidecars/registry";

const idSchema = z.enum([...SIDECAR_IDS, "activitywatch"]);

// POST /api/sidecars/:id/stop — SIGTERM, brief wait, SIGKILL for bundled
// sidecars; best-effort graceful quit for ActivityWatch (a failed quit
// reports "couldn't confirm it stopped", not a hard error).

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = idSchema.safeParse((await ctx.params).id);
  if (!parsed.success) {
    return NextResponse.json({ error: "unknown sidecar" }, { status: 404 });
  }
  const result = await stopById(parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
