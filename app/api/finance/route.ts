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
import { categoryReference } from "@/lib/finance/categorize";
import { importNewStatements, statementsDir } from "@/lib/finance/ingest";
import { getComparisonPeriod, getLatestPeriod, periodsWithData } from "@/lib/finance/query";
import { billRadar } from "@/lib/finance/radar";
import { getTool } from "@/lib/tools";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("import") }),
  // Renewal→calendar: the UI proposes, the user reviews and confirms, and
  // only then does this execute — bulk calendar writes stay confirm-gated.
  z.object({
    action: z.literal("create_renewal_events"),
    events: z
      .array(
        z.object({
          title: z.string().min(1).max(300),
          start: z.string().min(1).max(40),
        })
      )
      .min(1)
      .max(20),
  }),
]);

export async function GET(req: NextRequest) {
  const db = getDb();
  const statements = db
    .prepare("SELECT id, month, file_path, imported_at FROM statements ORDER BY imported_at DESC")
    .all();
  const txCount = (db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n;

  // Month navigation: an explicit ?month=YYYY-MM the user paged to, but only if
  // it actually has data; otherwise fall back to the derived latest period so a
  // stale/empty request can't render a misleading all-zero month.
  const periods = periodsWithData();
  const requested = req.nextUrl.searchParams.get("month");
  const period =
    requested && periods.includes(requested) ? requested : getLatestPeriod();

  return NextResponse.json({
    statementsDir: statementsDir(),
    statements,
    transactionCount: txCount,
    periods, // every YYYY-MM with data, for the month selector
    currentPeriod: period, // the month being shown (derived or explicit)
    comparisonPeriod: getComparisonPeriod(),
    spendByCategory: spendByCategory(period ?? undefined),
    recurring: recurringCharges(),
    radar: billRadar(),
    summaries: monthSummaries(period ?? undefined),
    goals: listGoals(),
    cutbacks: cutbackSuggestions(),
    categoryReference: categoryReference(), // 15 categories + real keyword rules
  });
}

export async function POST(req: NextRequest) {
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }

  if (parsed.data.action === "import") {
    const results = await importNewStatements();
    return NextResponse.json({ results });
  }

  // create_renewal_events — executes only after the user's explicit
  // confirm click; goes through the registered tool (zod-revalidated)
  // so calendar writes have exactly one code path, and is logged.
  const tool = getTool("create_calendar_event");
  if (!tool) return NextResponse.json({ error: "Calendar tool missing" }, { status: 500 });
  const created: string[] = [];
  const failed: string[] = [];
  for (const event of parsed.data.events) {
    const args = { title: event.title, start: event.start };
    const validated = tool.schema.safeParse(args);
    if (!validated.success) {
      failed.push(`${event.title}: ${z.prettifyError(validated.error)}`);
      continue;
    }
    try {
      created.push(await tool.handler(validated.data));
    } catch (err) {
      failed.push(`${event.title}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  try {
    getDb()
      .prepare("INSERT INTO agent_log (user_text, tool_calls, result) VALUES (?, ?, ?)")
      .run(
        "[CONFIRMED] create renewal calendar events",
        JSON.stringify(parsed.data.events),
        [...created, ...failed].join("\n")
      );
  } catch (err) {
    console.error("agent_log write failed:", err);
  }
  return NextResponse.json({ created, failed });
}
