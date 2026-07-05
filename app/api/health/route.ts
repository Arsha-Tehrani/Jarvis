import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { HEALTH_KINDS, healthHistory, logMetric } from "@/lib/health";

const postSchema = z.object({
  kind: z.enum(HEALTH_KINDS),
  value: z.number(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD").optional(),
  notes: z.string().max(2000).optional(),
});

export async function GET(req: NextRequest) {
  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("days")) || 30));
  return NextResponse.json({ rows: healthHistory(days) });
}

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  try {
    const date = logMetric(
      parsed.data.kind,
      parsed.data.value,
      parsed.data.date,
      parsed.data.notes
    );
    return NextResponse.json({ ok: true, date }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to log" },
      { status: 400 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const kind = req.nextUrl.searchParams.get("kind") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !HEALTH_KINDS.includes(kind as never)) {
    return NextResponse.json({ error: "Need date=YYYY-MM-DD and a valid kind" }, { status: 400 });
  }
  const info = getDb()
    .prepare("DELETE FROM health_logs WHERE date = ? AND kind = ?")
    .run(date, kind);
  if (info.changes === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
