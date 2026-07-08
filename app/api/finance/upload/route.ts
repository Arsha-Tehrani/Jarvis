import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { importNewStatements, statementsDir } from "@/lib/finance/ingest";

// Browser upload → /statements → the SAME import pipeline as manual drops.
// Files land in the gitignored statements folder and never leave the
// machine; parsing/redaction/categorization all happen in importNewStatements.

const MAX_BYTES = 25 * 1024 * 1024;

const fileMetaSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/\.(csv|pdf)$/i, "only .csv and .pdf statements are accepted"),
  size: z
    .number()
    .int()
    .positive("empty file")
    .max(MAX_BYTES, "file exceeds the 25 MB limit"),
});

type Rejection = { name: string; reason: string };

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { error: 'Expected multipart/form-data with one or more "files" entries' },
      { status: 400 }
    );
  }
  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return NextResponse.json(
      { error: 'No files received — send them as "files" form entries' },
      { status: 400 }
    );
  }

  const dir = statementsDir();
  const saved: string[] = [];
  const rejected: Rejection[] = [];

  for (const file of files) {
    // basename() strips any path the browser (or a crafted request) sends.
    const base = path.basename(file.name).replace(/[\x00-\x1f]/g, "").trim();
    const parsed = fileMetaSchema.safeParse({ name: base, size: file.size });
    if (!parsed.success) {
      rejected.push({ name: file.name, reason: z.prettifyError(parsed.error) });
      continue;
    }
    // Same name already in /statements → refuse rather than overwrite or
    // save a suffixed copy: a copy would re-import the same transactions,
    // and silently duplicated financial data is worse than an error.
    const target = path.join(dir, base);
    if (fs.existsSync(target)) {
      rejected.push({
        name: base,
        reason: "a file with this name is already in /statements — rename it if this is genuinely a different statement",
      });
      continue;
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (/\.pdf$/i.test(base) && !bytes.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
      rejected.push({ name: base, reason: "not a valid PDF (missing %PDF header)" });
      continue;
    }
    fs.writeFileSync(target, bytes);
    saved.push(base);
  }

  // Saved something → run the existing ingest (parses ALL new files in the
  // folder, including any dropped manually — one pipeline, one behavior).
  const results = saved.length > 0 ? await importNewStatements() : [];

  return NextResponse.json(
    { saved, rejected, results },
    { status: saved.length > 0 ? 201 : 400 }
  );
}
