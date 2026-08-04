import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { queryAgentLog } from "@/lib/agent/log";

// Read side of the agent turn log — newest first, filterable by status, date,
// and a substring over the user's input + any error detail. Read-only; the
// only writer is lib/agent/log.ts (via the agent route). Mirrors the
// network-log route's shape.

const querySchema = z.object({
  status: z
    .enum(["ok", "validation_error", "execution_error", "llm_error", "pending_confirmation"])
    .optional(),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD")
    .optional(),
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    status: p.get("status") ?? undefined,
    since: p.get("since") ?? undefined,
    q: p.get("q") ?? undefined,
    limit: p.get("limit") ?? undefined,
    offset: p.get("offset") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { limit, offset } = parsed.data;
  const { rows, total } = queryAgentLog(getDb(), parsed.data);
  return NextResponse.json({ rows, total, limit, offset });
}
