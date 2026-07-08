import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteDividend, dividendSummary, logDividend } from "@/lib/dividends";

// Manual dividend log (free-tier quote providers don't expose dividends).
// GET returns the running total + per-holding breakdown; POST logs an event.

export async function GET() {
  return NextResponse.json(dividendSummary());
}

const logSchema = z.object({
  ticker: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z.\-]+$/, "ticker must be letters/dots/dashes")
    .transform((s) => s.toUpperCase()),
  ex_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ex-date must be YYYY-MM-DD"),
  amount_per_share: z.number().positive("amount/share must be > 0"),
  // Optional: shares held on the ex-date. Omit to approximate from the current
  // share count (flagged in the UI).
  shares_at_date: z.number().min(0).optional(),
  note: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = logSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { ticker, ex_date, amount_per_share, shares_at_date, note } = parsed.data;
  logDividend(ticker, ex_date, amount_per_share, shares_at_date ?? null, note ?? null);
  return NextResponse.json(dividendSummary(), { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  if (!deleteDividend(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(dividendSummary());
}
