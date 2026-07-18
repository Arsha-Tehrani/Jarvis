import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  StocksNotConfiguredError,
  getQuotes,
  isStocksConfigured,
  trackedTickers,
  type Quote,
} from "@/lib/stocks";
import { computePortfolioTotal } from "@/lib/stocks/portfolio-total";

const tickerField = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^[A-Za-z.\-]+$/, "ticker must be letters/dots/dashes")
  .transform((s) => s.toUpperCase());

const addSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("holding"),
    ticker: tickerField,
    shares: z.number().positive(),
    cost_basis: z.number().min(0),
  }),
  z.object({ kind: z.literal("watch"), ticker: tickerField }),
]);

export async function GET() {
  const db = getDb();
  const holdings = db
    .prepare(
      "SELECT id, ticker, shares, cost_basis, is_cash_equivalent FROM holdings ORDER BY ticker"
    )
    .all() as {
    id: number;
    ticker: string;
    shares: number;
    cost_basis: number;
    is_cash_equivalent: number;
  }[];
  const watchlist = db
    .prepare("SELECT id, ticker FROM watchlist ORDER BY ticker")
    .all() as { id: number; ticker: string }[];

  let quotes: Map<string, Quote> = new Map();
  let quotesError: string | null = null;
  const tickers = trackedTickers();
  if (tickers.length > 0) {
    try {
      quotes = await getQuotes(tickers);
    } catch (err) {
      quotesError = err instanceof Error ? err.message : "Quote fetch failed";
      if (!(err instanceof StocksNotConfiguredError)) {
        console.error("[stocks] quote fetch failed:", err);
      }
    }
  }

  // Same computePortfolioTotal the Today card and net worth use, so a
  // holding with no live quote (e.g. the SPAXX money-market core, which has
  // no Finnhub symbol) is valued at cost basis identically everywhere
  // instead of three independent implementations drifting apart.
  const { holdings: priced } = computePortfolioTotal(holdings, (t) => quotes.get(t));

  return NextResponse.json({
    configured: isStocksConfigured(),
    quotesError,
    holdings: priced,
    watchlist: watchlist.map((w) => {
      const q = quotes.get(w.ticker.toUpperCase());
      return {
        ...w,
        price: q?.price ?? null,
        change: q?.change ?? null,
        changePercent: q?.changePercent ?? null,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const db = getDb();
  if (parsed.data.kind === "holding") {
    const { ticker, shares, cost_basis } = parsed.data;
    db.prepare(
      `INSERT INTO holdings (ticker, shares, cost_basis) VALUES (?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET shares = excluded.shares, cost_basis = excluded.cost_basis`
    ).run(ticker, shares, cost_basis);
  } else {
    db.prepare("INSERT OR IGNORE INTO watchlist (ticker) VALUES (?)").run(parsed.data.ticker);
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}

const correctionSchema = z.object({
  id: z.number().int().positive(),
  is_cash_equivalent: z.boolean(),
});

// Manual override for the Stocks page's Stocks-vs-Cash-equivalent chart
// split — same pattern as the Finance import log's account-type correction
// dropdown: a real, per-row column, corrected by hand, and never re-derived
// from the seed ticker table afterward (lib/stocks/cash-equivalents.ts only
// seeds it once, at migration time).
export async function PATCH(req: NextRequest) {
  const parsed = correctionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { id, is_cash_equivalent } = parsed.data;
  const info = getDb()
    .prepare("UPDATE holdings SET is_cash_equivalent = ? WHERE id = ?")
    .run(is_cash_equivalent ? 1 : 0, id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Holding not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind");
  const id = Number(req.nextUrl.searchParams.get("id"));
  if ((kind !== "holding" && kind !== "watch") || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Need kind=holding|watch and a valid id" }, { status: 400 });
  }
  const table = kind === "holding" ? "holdings" : "watchlist";
  const info = getDb().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
