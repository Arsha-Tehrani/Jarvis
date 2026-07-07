import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { queueSyncPush } from "@/lib/sync/client";
import {
  fetchLeetCodeStats,
  latestLeetCodeRow,
  saveLeetCodeStats,
} from "@/lib/leetcode";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Two POST shapes: {action:"refresh"} pulls from leetcode.com (unofficial —
// may fail; manual entry below always works); a manual body stores a row.
const refreshSchema = z.object({
  action: z.literal("refresh"),
  username: z.string().min(1).max(100).optional(),
});

const manualSchema = z.object({
  date: z.string().regex(DATE_RE, "date must be YYYY-MM-DD").optional(),
  total_solved: z.number().int().min(0),
  streak: z.number().int().min(0).optional(),
  recent: z
    .array(z.object({ title: z.string(), titleSlug: z.string(), timestamp: z.string() }))
    .optional(),
});

export async function GET() {
  const latest = latestLeetCodeRow();
  const history = getDb()
    .prepare(
      "SELECT date, total_solved, streak FROM leetcode_stats ORDER BY date DESC LIMIT 30"
    )
    .all();
  return NextResponse.json({
    latest: latest
      ? { ...latest, recent: latest.recent ? JSON.parse(latest.recent) : [] }
      : null,
    history,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  const refresh = refreshSchema.safeParse(body);
  if (refresh.success) {
    const username = refresh.data.username ?? process.env.LEETCODE_USERNAME;
    if (!username) {
      return NextResponse.json(
        { error: "Set LEETCODE_USERNAME in .env.local (or pass username) to pull stats. Manual entry works without it." },
        { status: 400 }
      );
    }
    try {
      const stats = await fetchLeetCodeStats(username);
      saveLeetCodeStats(new Date().toISOString().slice(0, 10), stats);
      queueSyncPush(); // debounced, non-blocking; no-op unless SYNC_ROLE=client
      return NextResponse.json({ ok: true, stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : "LeetCode pull failed";
      console.error("[leetcode] refresh failed:", err);
      return NextResponse.json(
        { error: `${message}. The unofficial API may have changed — use manual entry.` },
        { status: 502 }
      );
    }
  }

  const manual = manualSchema.safeParse(body);
  if (manual.success) {
    const previous = latestLeetCodeRow();
    const date = manual.data.date ?? new Date().toISOString().slice(0, 10);
    saveLeetCodeStats(date, {
      totalSolved: manual.data.total_solved,
      streak: manual.data.streak ?? previous?.streak ?? 0,
      recent: manual.data.recent ?? [],
    });
    queueSyncPush();
    return NextResponse.json({ ok: true }, { status: 201 });
  }

  return NextResponse.json(
    { error: z.prettifyError(manual.error) },
    { status: 400 }
  );
}
