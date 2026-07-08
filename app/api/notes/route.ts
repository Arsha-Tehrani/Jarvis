import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  VaultNotConfiguredError,
  allNotes,
  appendNote,
  isVaultConfigured,
  readNote,
  recentNotes,
  searchNotes,
  todaysDailyNote,
} from "@/lib/notes";

const appendSchema = z.object({
  path: z.string().min(1).max(500).optional(),
  text: z.string().min(1).max(10_000),
});

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  const notePath = req.nextUrl.searchParams.get("path");
  try {
    if (notePath) return NextResponse.json({ note: readNote(notePath) });
    if (q) return NextResponse.json({ results: searchNotes(q) });
    return NextResponse.json({
      configured: true,
      dailyNote: todaysDailyNote(),
      recent: recentNotes(),
      all: allNotes(),
    });
  } catch (err) {
    if (err instanceof VaultNotConfiguredError) {
      return NextResponse.json(
        { configured: false, error: err.message },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : "Vault read failed";
    console.error("[notes] read failed:", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  if (!isVaultConfigured()) {
    return NextResponse.json(
      { error: new VaultNotConfiguredError().message },
      { status: 409 }
    );
  }
  const parsed = appendSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  try {
    const written = appendNote(parsed.data.path, parsed.data.text);
    return NextResponse.json({ ok: true, path: written }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Append failed";
    console.error("[notes] append failed:", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
