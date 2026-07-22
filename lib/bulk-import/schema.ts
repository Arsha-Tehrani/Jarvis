// Pure half of the bulk task-list import (spec: parse, group-with-reasoning,
// log). No db/network imports so `node --test` can exercise everything here
// directly — same pure/impure split as lib/finance/classify-llm-assist-schema.ts
// (pure gate) vs classify-llm-assist.ts (network glue).

import { z } from "zod";

// ---- model-output schema (the validation gate) ------------------------------
// Same contract as every other LLM extraction point in this codebase: strict
// JSON against zod, one repair pass (lib/bulk-import/parse.ts), then a hard
// reject. Unvalidated output never reaches the preview screen or the DB.

const nullableText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v && v.trim() ? v : null));

export const bulkTaskSchema = z.object({
  // Short, action-oriented; checkbox glyphs/reference numbers stripped.
  title: z.string().trim().min(1).max(200),
  // Everything that doesn't belong in a short title: phone numbers, URLs,
  // contacts, "why" context, sub-bullets. Maps to tasks.description.
  notes: nullableText(2000),
  // Only when the text implies one — null over a guess.
  due_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .transform((v) => v ?? null),
  // Only when urgency is implied; null falls back to the app default ('high').
  priority: z
    .enum(["urgent", "high", "later"])
    .nullish()
    .transform((v) => v ?? null),
  // "after confirming biologic name/dose" — a plain note, NOT a formal
  // dependency graph (deliberately out of scope, per spec).
  dependsOnNote: nullableText(500),
  // Hard date-anchored triggers that need a notification, not a list entry.
  suggestAsReminder: z.boolean().default(false),
});

export const bulkGroupSchema = z.object({
  name: z.string().trim().min(1).max(200),
  // Schema-REQUIRED: a group with no stated reasoning fails the gate.
  reasoning: z.string().trim().min(1).max(1000),
  tasks: z.array(bulkTaskSchema).min(1).max(100),
});

export const bulkProposalSchema = z.object({
  groups: z.array(bulkGroupSchema).min(1).max(50),
});

export type BulkTask = z.infer<typeof bulkTaskSchema>;
export type BulkGroup = z.infer<typeof bulkGroupSchema>;
export type BulkProposal = z.infer<typeof bulkProposalSchema>;

// Extract + parse + validate a raw model reply. Throws with a clear reason on
// any malformed shape (the thrown message is what the repair pass shows the
// model on its one retry).
export function parseBulkImportResponse(raw: string): BulkProposal {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("LLM response contained no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("LLM response was not valid JSON");
  }
  const validated = bulkProposalSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`LLM response failed validation: ${z.prettifyError(validated.error)}`);
  }
  return validated.data;
}

// ---- source-mode detection --------------------------------------------------
// Structured input (the source has its own section headers, like
// "A. Confirm Medicaid Status") → respect the source's grouping; the model
// extracts, it does not re-organize. Unstructured → the model proposes its
// own thematic groups and must state per-group reasoning.

export type SourceMode = "structured" | "unstructured";

export type Section = { name: string; body: string };

// A header: markdown heading, lettered ("A." / "A)"), or a short standalone
// numbered line ("1." / "1)") — matched conservatively so ordinary sentence
// lines and checklist items don't count.
const HEADER_RE = /^\s{0,3}(?:#{1,6}\s+(.+)|([A-Z])[.)]\s+(.+)|(\d{1,2})[.)]\s+(.{1,80}))\s*$/;
// A line that reads as an item under a header: bullet, checkbox glyph, or
// indented continuation.
const ITEM_RE = /^\s*(?:[-*•‣▪]|☐|☑|✓|\[[ xX]?\])\s+\S|^\s{2,}\S/;

function headerName(line: string): string | null {
  const m = HEADER_RE.exec(line);
  if (!m) return null;
  const name = m[1] ?? (m[2] !== undefined ? `${m[2]}. ${m[3]}` : `${m[4]}. ${m[5]}`);
  return name.trim();
}

/**
 * Split into the source's own sections when it has real headers (each header
 * followed by at least one bullet/checkbox/indented item before the next
 * header), or return null for a flat/unstructured paste. Two or more such
 * sections make the input "structured".
 */
export function splitSections(text: string): Section[] | null {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let current: { name: string; lines: string[] } | null = null;
  const preamble: string[] = [];

  for (const line of lines) {
    const name = headerName(line);
    if (name !== null) {
      if (current) sections.push({ name: current.name, body: current.lines.join("\n").trim() });
      current = { name, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push({ name: current.name, body: current.lines.join("\n").trim() });

  const withItems = sections.filter(
    (s) => s.body.length > 0 && s.body.split(/\r?\n/).some((l) => ITEM_RE.test(l))
  );
  if (withItems.length < 2) return null;

  // Keep ALL non-empty sections in original order (a section whose items
  // aren't bullet-shaped still belongs to the user's structure); prepend any
  // preamble text to the first section so nothing is dropped.
  const kept = sections.filter((s) => s.body.length > 0);
  const pre = preamble.join("\n").trim();
  if (pre && kept.length > 0) kept[0] = { ...kept[0], body: `${pre}\n${kept[0].body}` };
  return kept;
}

export function detectSourceMode(text: string): SourceMode {
  return splitSections(text) ? "structured" : "unstructured";
}

// ---- chunking ---------------------------------------------------------------
// Don't assume the whole paste fits one call forever. Below the threshold:
// one chunk. Above: split on the source's own structural boundaries first
// (section headers, else blank-line blocks) — never mid-sentence — process
// each chunk independently, concatenate resulting groups in original order.
// Mirrors the textbook-RAG sidecar's rule of never splitting a unit that
// needs to stay together.

export const CHUNK_THRESHOLD_CHARS = 8000;

export function splitIntoChunks(text: string, threshold = CHUNK_THRESHOLD_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= threshold) return [trimmed];

  const sections = splitSections(trimmed);
  const units = sections
    ? sections.map((s) => `${s.name}\n${s.body}`)
    : trimmed.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current && current.length + unit.length + 2 > threshold) {
      chunks.push(current);
      current = unit;
    } else {
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---- prompt -----------------------------------------------------------------

export function buildParseMessages(
  chunk: string,
  mode: SourceMode,
  todayIso: string
): Array<{ role: "system" | "user"; content: string }> {
  const shared = [
    "You extract action items from a pasted task list / notes dump for a personal task app.",
    'Respond with ONLY JSON: {"groups":[{"name":"...","reasoning":"...","tasks":[{"title":"...","notes":"..."|null,"due_at":"YYYY-MM-DD"|null,"priority":"urgent"|"high"|"later"|null,"dependsOnNote":"..."|null,"suggestAsReminder":true|false}]}]}. No prose outside the JSON.',
    `Today is ${todayIso} — resolve explicit relative dates ("Friday", "next week") to concrete YYYY-MM-DD. If no date is implied, due_at MUST be null; never guess.`,
    "title: short and action-oriented, stripped of checkbox glyphs and reference numbers. notes: everything that doesn't fit a short title — phone numbers, URLs, named contacts, why-context, sub-details. Never drop such detail and never cram it into the title.",
    "priority: only when urgency is stated or clearly implied ('do this first' → urgent, 'this week' → high); otherwise null.",
    "Sub-items: when a parent line has sub-bullets that are each independently actionable and completable on their own (e.g. four separate phone calls), emit one task per sub-item, each inheriting the parent's shared context in its notes. Collapse into ONE task with the sub-bullets in notes only when they are an inseparable reference list.",
    "Dependencies: when a task's content depends on the outcome of an earlier task in the same list, set dependsOnNote to a short phrase like 'after confirming the exact biologic name'. Do not invent a formal dependency structure.",
    "suggestAsReminder: true only for hard date-anchored triggers that need an actual notification (a deadline or expiry on a specific date far out), not for ordinary due dates.",
    "Condition-triggered items with no date (e.g. 'if X happens, revisit Y') stay tasks with due_at null.",
  ];
  const modeRules =
    mode === "structured"
      ? [
          "The input has its OWN section headers. Respect that grouping exactly: one group per source section, in source order, named after the source's header. Do NOT re-organize or invent new categories. reasoning: one sentence on why that section's items belong together, referencing the source's own header.",
        ]
      : [
          "The input is a flat, unstructured dump. Propose your own small set of thematic groups and give each group a one-sentence reasoning for why its items belong together (e.g. 'grouped together — all involve contacting the insurer directly').",
        ];
  return [
    { role: "system", content: [...shared, ...modeRules].join(" ") },
    { role: "user", content: chunk },
  ];
}
