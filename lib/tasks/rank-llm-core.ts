import { z } from "zod";
import type { DbLike, Priority } from "./rank";

// Pure half of the LLM ranking refinement: the zod gate that decides whether
// a model reply is allowed to touch the database, and the applier that
// writes a validated reply. The chat() call itself lives in rank-llm.ts
// (thin, untested glue). Contract under test: unvalidated output never
// executes — any malformed reply leaves the deterministic ranks (and
// llm_rank_source='deterministic') exactly as they were.

const rankingSchema = z.object({
  id: z.number().int(),
  rank: z.number().int().min(1),
  suggested_priority: z.enum(["urgent", "high", "later"]),
  rationale: z.string(),
});

const replySchema = z.object({ rankings: z.array(rankingSchema) });

export type LlmRanking = z.infer<typeof rankingSchema>;

// Strict JSON gate: parses the raw model text and demands every open task id
// exactly once with ranks forming a permutation of 1..N. Returns null on ANY
// violation — the caller keeps the deterministic ranks and logs once.
export function parseRankings(raw: string, openIds: readonly number[]): LlmRanking[] | null {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) return null;
  const { rankings } = parsed.data;

  if (rankings.length !== openIds.length) return null;
  const wantIds = new Set(openIds);
  const seenIds = new Set<number>();
  const seenRanks = new Set<number>();
  for (const r of rankings) {
    if (!wantIds.has(r.id) || seenIds.has(r.id)) return null; // extra or duplicate id
    if (r.rank < 1 || r.rank > openIds.length || seenRanks.has(r.rank)) return null;
    seenIds.add(r.id);
    seenRanks.add(r.rank);
  }
  // ids exactly once + ranks in [1..N] with no duplicates = permutation.
  return rankings.map((r) => ({ ...r, rationale: r.rationale.slice(0, 120) }));
}

// Models under instruction to return "STRICT JSON only" still love a
// ```json fence. Peel it off; anything worse fails the parse and falls back.
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : raw).trim();
}

// Write a VALIDATED reply: llm_rank + llm_rank_source='llm' on every open
// task; llm_suggested_priority/llm_rationale only where the model disagrees
// with the stored priority (cleared otherwise — a stale suggestion for a
// priority the user already applied would be noise). Never touches priority
// itself: suggestions are advisory, applied only by an explicit user click.
export function applyLlmRankings(
  db: DbLike,
  rankings: readonly LlmRanking[]
): void {
  const current = db
    .prepare(`SELECT id, priority FROM tasks WHERE status = 'open' AND deleted_at IS NULL`)
    .all() as Array<{ id: number; priority: Priority }>;
  const priorityOf = new Map(current.map((t) => [t.id, t.priority]));
  const update = db.prepare(
    `UPDATE tasks SET llm_rank = ?, llm_rank_source = 'llm',
       llm_suggested_priority = ?, llm_rationale = ? WHERE id = ?`
  );
  for (const r of rankings) {
    const disagrees = priorityOf.get(r.id) !== r.suggested_priority;
    update.run(
      r.rank,
      disagrees ? r.suggested_priority : null,
      disagrees ? r.rationale : null,
      r.id
    );
  }
}
