import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assembleDigestFacts,
  renderStructuredDigest,
  weeklyDigestJob,
} from "@/lib/digest";
import { isVaultConfigured } from "@/lib/notes";

// GET: deterministic preview of what the digest would write.
// POST {action:"run", force?}: run the job now (force ignores the weekly
// marker) — same code path the Sunday cron uses.
const postSchema = z.object({
  action: z.literal("run"),
  force: z.boolean().optional(),
});

export async function GET() {
  const facts = assembleDigestFacts();
  return NextResponse.json({
    vaultConfigured: isVaultConfigured(),
    facts,
    markdown: renderStructuredDigest(facts),
  });
}

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  if (!isVaultConfigured()) {
    return NextResponse.json(
      { error: "OBSIDIAN_VAULT_PATH is not set — the digest writes into the vault" },
      { status: 409 }
    );
  }
  const written = await weeklyDigestJob(parsed.data.force ?? false);
  return NextResponse.json({
    ok: written != null,
    written,
    note: written == null ? "Already written this week (use force:true to re-run)" : undefined,
  });
}
