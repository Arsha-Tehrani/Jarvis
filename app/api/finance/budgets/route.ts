import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { budgetStatus, setBudget } from "@/lib/finance/budgets";
import { CATEGORIES } from "@/lib/finance/categorize";

// Category budgets: GET the month-to-date status per budgeted category,
// PUT to set (or clear with null) one category's monthly limit.

const putSchema = z.object({
  category: z.enum(CATEGORIES),
  monthly_limit: z.number().positive().max(1_000_000).nullable(),
});

export async function GET() {
  return NextResponse.json({ status: budgetStatus(), categories: CATEGORIES });
}

export async function PUT(req: NextRequest) {
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  setBudget(parsed.data.category, parsed.data.monthly_limit);
  return NextResponse.json({ status: budgetStatus() });
}
