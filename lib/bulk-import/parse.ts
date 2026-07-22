// Network glue for the bulk task-list import: calls the LLM (via the provider
// abstraction) chunk by chunk through the pure one-repair-then-reject gate
// (parse-core.ts), and records the whole attempt in bulk_imports.
//
// One handler backs all three entry points (Tasks-page panel, the
// bulk_import_tasks agent tool, POST /api/tasks/bulk-import) — same
// convention as tracker deletion and calendar event creation.
//
// PRIVACY: bulk_imports.raw_input_text/proposed_json routinely contain the
// same category of sensitive personal content Notes/Finance/Mail keep
// local-only. The table is deliberately absent from lib/sync/tables.ts and
// lib/backup-tables.ts — never add it to either.

import { getDb } from "@/lib/db";
import { chat } from "@/lib/llm";
import { parseChunkWithRepair, type ChatLike } from "./parse-core.ts";
import {
  detectSourceMode,
  splitIntoChunks,
  type BulkGroup,
  type BulkProposal,
  type SourceMode,
} from "./schema.ts";

export type AnalyzeResult = {
  importId: number;
  sourceMode: SourceMode;
  proposal: BulkProposal;
};

// Parse the paste, validate, and record the proposal (status 'proposed').
// Writes NO tasks — every write path goes through the preview/confirm step
// (commitBulkImport). `chatFn` is injectable for tests; production uses chat.
export async function analyzeBulkImport(
  rawText: string,
  chatFn: ChatLike = chat
): Promise<AnalyzeResult> {
  const text = rawText.trim();
  if (!text) throw new Error("Nothing to import — the pasted text is empty.");

  const mode = detectSourceMode(text);
  const todayIso = new Date().toISOString().slice(0, 10);
  const groups: BulkGroup[] = [];
  let model: string | null = null;
  // Chunks processed independently, results concatenated in original order.
  for (const chunk of splitIntoChunks(text)) {
    const parsed = await parseChunkWithRepair(chunk, mode, todayIso, chatFn);
    groups.push(...parsed.groups);
    model = parsed.model ?? model;
  }
  const proposal: BulkProposal = { groups };

  const info = getDb()
    .prepare(
      `INSERT INTO bulk_imports (raw_input_text, source_mode, model_used, proposed_json, status)
       VALUES (?, ?, ?, ?, 'proposed')`
    )
    .run(text, mode, model, JSON.stringify(proposal));

  return { importId: Number(info.lastInsertRowid), sourceMode: mode, proposal };
}
