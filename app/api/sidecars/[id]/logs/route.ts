import { NextResponse } from "next/server";
import { z } from "zod";
import { sidecarLogs } from "@/lib/sidecars/manager";
import { SIDECAR_IDS } from "@/lib/sidecars/registry";

const idSchema = z.enum([...SIDECAR_IDS, "activitywatch"]);

// GET /api/sidecars/:id/logs — the bounded ring buffer (last ~200 lines),
// the troubleshooting path that replaces "read the terminal yourself".

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = idSchema.safeParse((await ctx.params).id);
  if (!parsed.success) {
    return NextResponse.json({ error: "unknown sidecar" }, { status: 404 });
  }
  const lines = sidecarLogs(parsed.data);
  return NextResponse.json({
    lines: lines ?? [],
    note: lines === null ? "not started from this server yet — no captured output" : undefined,
  });
}
