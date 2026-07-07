import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";

// Read side of the privacy audit log — recent outbound calls, optionally
// filtered by feature and/or day. The rows contain metadata only (host +
// feature + outcome); there is nothing sensitive here to begin with.

const querySchema = z.object({
  feature: z.string().min(1).max(100).optional(),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "day must be YYYY-MM-DD")
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    feature: params.get("feature") ?? undefined,
    day: params.get("day") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { feature, day, limit } = parsed.data;

  const where: string[] = [];
  const args: string[] = [];
  if (feature) {
    where.push("feature = ?");
    args.push(feature);
  }
  if (day) {
    where.push("substr(timestamp, 1, 10) = ?");
    args.push(day);
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, timestamp, feature, host, purpose, outcome, status_code, latency_ms
       FROM network_log
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC LIMIT ?`
    )
    .all(...args, limit);
  const features = db
    .prepare("SELECT DISTINCT feature FROM network_log ORDER BY feature")
    .all() as { feature: string }[];

  return NextResponse.json({ rows, features: features.map((f) => f.feature) });
}
