import { NextResponse } from "next/server";
import { z } from "zod";
import { startById } from "@/lib/sidecars/manager";
import { SIDECAR_IDS } from "@/lib/sidecars/registry";

// Bundled sidecars plus best-effort ActivityWatch launch.
const idSchema = z.enum([...SIDECAR_IDS, "activitywatch"]);

// POST /api/sidecars/:id/start — pre-flights readiness (not set up → clear
// error, never an attempted spawn) then launches the venv's python directly;
// for ActivityWatch, launches the installed app per-OS.

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = idSchema.safeParse((await ctx.params).id);
  if (!parsed.success) {
    return NextResponse.json({ error: "unknown sidecar" }, { status: 404 });
  }
  const result = await startById(parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
