import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  cutbackSuggestions,
  listGoals,
  monthSummaries,
  recurringCharges,
  spendByCategory,
} from "@/lib/finance/analyze";
import { importNewStatements, statementsDir } from "@/lib/finance/ingest";

const actionSchema = z.object({ action: z.literal("import") });

export async function GET() {
  const db = getDb();
  const statements = db
    .prepare("SELECT id, month, file_path, imported_at FROM statements ORDER BY imported_at DESC")
    .all();
  const txCount = (db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n;
  return NextResponse.json({
    statementsDir: statementsDir(),
    statements,
    transactionCount: txCount,
    spendByCategory: spendByCategory(),
    recurring: recurringCharges(),
    summaries: monthSummaries(),
    goals: listGoals(),
    cutbacks: cutbackSuggestions(),
  });
}

export async function POST(req: NextRequest) {
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Expected {"action":"import"}' }, { status: 400 });
  }
  const results = await importNewStatements();
  return NextResponse.json({ results });
}
