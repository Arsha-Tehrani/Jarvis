import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// Manual re-ingest trigger for the textbook-RAG sidecar's existing POST
// /ingest — a UI proxy, not a new pipeline. /ingest already replaces rather
// than duplicates a book's chunks (README), so re-running it after a parser
// fix or an edited book needs no confirm gate: nothing is lost, only
// refreshed. The app has no book-listing UI (books are ingested by absolute
// path, per sidecars/textbook-rag's own CLI/README), so this takes the path
// directly rather than inventing a book-tracking feature that doesn't exist.

const bodySchema = z.object({ path: z.string().trim().min(1).max(4096) });

const sidecarResponseSchema = z.object({
  source: z.string(),
  engine: z.string(),
  chunks: z.number(),
  collection_total: z.number(),
});

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }

  const base = process.env.TEXTBOOK_RAG_URL ?? "http://localhost:8016";
  let res: Response;
  try {
    res = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: parsed.data.path }),
    });
  } catch {
    return NextResponse.json(
      {
        error: `Textbook sidecar not running at ${base}. Start it: sidecars/textbook-rag/.venv/Scripts/python -m rag.server`,
      },
      { status: 502 }
    );
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (data as { detail?: unknown })?.detail;
    return NextResponse.json(
      { error: typeof detail === "string" ? detail : `Re-ingest failed (${res.status})` },
      { status: 502 }
    );
  }
  const validated = sidecarResponseSchema.safeParse(data);
  if (!validated.success) {
    return NextResponse.json(
      { error: "Textbook sidecar returned an unexpected response shape" },
      { status: 502 }
    );
  }
  return NextResponse.json(validated.data);
}
