import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { listGoals } from "@/lib/finance/analyze";
import { GOAL_KINDS, upsertGoal } from "@/lib/finance/goals";

const upsertSchema = z.object({
  kind: z.enum(GOAL_KINDS),
  target: z.number().positive().max(1_000_000),
  period: z.enum(["week", "month"]).optional(),
});

export async function GET() {
  return NextResponse.json({ goals: listGoals() });
}

export async function POST(req: NextRequest) {
  const parsed = upsertSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  upsertGoal(parsed.data.kind, parsed.data.target, parsed.data.period);
  return NextResponse.json({ goals: listGoals() }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const info = getDb().prepare("DELETE FROM goals WHERE id = ?").run(id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
