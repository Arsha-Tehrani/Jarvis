import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addMeals, deleteMeal, getDayNutrition, mealBatchSchema } from "@/lib/nutrition";

// GET ?date=YYYY-MM-DD → day's entries + macro totals + calorie goal.
// POST (macro sidecar) { entries: [...], source: 'photo'|'text', date? } —
// zod-validated; unvalidated model output never reaches the table.
// DELETE ?id=N → remove one entry (undo from the Trackers card).

export async function GET(req: NextRequest) {
  const date =
    req.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  return NextResponse.json(getDayNutrition(date));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = mealBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const added = addMeals(parsed.data);
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  return NextResponse.json({ added, ...getDayNutrition(date) });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 });
  }
  if (!deleteMeal(id)) {
    return NextResponse.json({ error: `No entry ${id}` }, { status: 404 });
  }
  return NextResponse.json({ deleted: id });
}
