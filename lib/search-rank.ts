// Pure pieces of the semantic search tier: vector encode/decode, cosine
// similarity, ranking, and exact/fuzzy merge. No db/network imports so
// `node --test` exercises them directly.

export type IndexedVector = { source: string; refId: string; text: string; vector: Float32Array };
export type RankedHit = { source: string; refId: string; text: string; score: number };

// Embeddings are stored as little-endian float32 BLOBs.
export function encodeVector(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

export function decodeVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Below this cosine similarity a hit is noise, not a fuzzy match.
export const MIN_SCORE = 0.5;

export function rankBySimilarity(
  query: ArrayLike<number>,
  index: IndexedVector[],
  { minScore = MIN_SCORE, limit = 5 }: { minScore?: number; limit?: number } = {}
): RankedHit[] {
  return index
    .map((row) => ({
      source: row.source,
      refId: row.refId,
      text: row.text,
      score: cosineSimilarity(query, row.vector),
    }))
    .filter((hit) => hit.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// The exact (LIKE) tier answered first; fuzzy hits that duplicate one of its
// titles add nothing, so drop them. Indexed text isn't always byte-identical
// to the exact tier's display title ("subject — sender" vs "subject",
// "note" vs "note.md"), so either being a prefix of the other counts as a dupe.
export function dedupeAgainstExact(hits: RankedHit[], exactTitles: string[]): RankedHit[] {
  const titles = exactTitles.map((t) => t.toLowerCase());
  return hits.filter((h) => {
    const text = h.text.toLowerCase();
    return !titles.some((t) => text.startsWith(t) || t.startsWith(text));
  });
}
