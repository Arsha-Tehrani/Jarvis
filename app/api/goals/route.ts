import { NextResponse } from "next/server";
import { listGoals } from "@/lib/finance/analyze";
import { computeGoalsProgress } from "@/lib/goals-progress";

// Read side of the goals dashboard. Writes go through the existing
// /api/finance/goals CRUD (one code path for goal edits).
export async function GET() {
  return NextResponse.json({
    progress: computeGoalsProgress(),
    goals: listGoals(),
  });
}
