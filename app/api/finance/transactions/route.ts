import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { CATEGORIES, explainCategory } from "@/lib/finance/categorize";
import { detectRecurring } from "@/lib/finance/ingest";

// Transaction list + manual re-categorize. The list carries a derived "why"
// (which keyword matched, or "assigned by the model") generated from the real
// rules — never a hand-written copy that can drift.

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month");
  const db = getDb();
  const rows = (
    month && /^\d{4}-\d{2}$/.test(month)
      ? db
          .prepare(
            `SELECT id, date, amount, merchant, category, raw_description, is_recurring
             FROM transactions WHERE substr(date, 1, 7) = ? ORDER BY date DESC, id DESC`
          )
          .all(month)
      : db
          .prepare(
            `SELECT id, date, amount, merchant, category, raw_description, is_recurring
             FROM transactions ORDER BY date DESC, id DESC LIMIT 500`
          )
          .all()
  ) as Array<{
    id: number;
    date: string;
    amount: number;
    merchant: string;
    category: string;
    raw_description: string;
    is_recurring: number;
  }>;

  return NextResponse.json({
    categories: CATEGORIES,
    transactions: rows.map((r) => ({
      ...r,
      why: explainCategory(r.raw_description, r.category),
    })),
  });
}

const patchSchema = z.object({
  id: z.number().int().positive(),
  category: z.enum(CATEGORIES),
  // Also apply to every existing transaction from the same merchant, and
  // remember the correction so future imports of that merchant stick.
  applyToFuture: z.boolean().optional().default(false),
});

export async function PATCH(req: NextRequest) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { id, category, applyToFuture } = parsed.data;
  const db = getDb();

  const row = db.prepare("SELECT id, merchant FROM transactions WHERE id = ?").get(id) as
    | { id: number; merchant: string }
    | undefined;
  if (!row) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });

  let updated = 0;
  const apply = db.transaction(() => {
    if (applyToFuture) {
      // Remember the merchant→category rule and back-apply it to all existing
      // rows from that merchant.
      db.prepare(
        `INSERT INTO category_overrides (merchant, category) VALUES (?, ?)
         ON CONFLICT(merchant) DO UPDATE SET category = excluded.category`
      ).run(row.merchant, category);
      updated = db
        .prepare("UPDATE transactions SET category = ? WHERE merchant = ?")
        .run(category, row.merchant).changes;
    } else {
      updated = db.prepare("UPDATE transactions SET category = ? WHERE id = ?").run(category, id).changes;
    }
  });
  apply();

  // Recurring flags key off amounts/cadence, unaffected by category — but a
  // re-categorize can change what counts as spend, so keep the radar honest.
  detectRecurring();

  return NextResponse.json({ ok: true, updated, appliedToFuture: applyToFuture });
}
