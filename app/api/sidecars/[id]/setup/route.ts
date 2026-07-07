import { NextResponse } from "next/server";
import { z } from "zod";
import { setupSidecar } from "@/lib/sidecars/manager";
import { SIDECAR_IDS } from "@/lib/sidecars/registry";

// POST /api/sidecars/:id/setup — create the venv if missing, then pip
// install -r requirements.txt (idempotent; no-ops satisfied packages).
// Bundled sidecars only — ActivityWatch is third-party and not installable
// from here. Runs in the background; output streams to the same log buffer
// the Start/Stop panel already shows, and the card reads "setting up" until
// the readiness check flips.

const idSchema = z.enum(SIDECAR_IDS);

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = idSchema.safeParse((await ctx.params).id);
  if (!parsed.success) {
    return NextResponse.json({ error: "unknown sidecar" }, { status: 404 });
  }
  const result = setupSidecar(parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true }, { status: 202 });
}
