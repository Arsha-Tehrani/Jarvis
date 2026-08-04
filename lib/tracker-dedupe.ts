// Pure tracker de-duplication (no DB/LLM import) so node --test exercises it
// directly. When a new tracker/habit is created, this deterministic check runs
// first against every existing tracker; an optional LLM pass (in the DB layer)
// can catch closer semantic matches. Either way it's a SUGGESTION, never a
// silent block.

// Lowercase alphanumerics only — "Gym 🏋️" and "gym" collapse to "gym".
export function normalizeTrackerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Token set from a name, splitting on non-alphanumerics, dropping stopwords so
// "go to the gym" ≈ "gym".
const STOPWORDS = new Set(["to", "the", "a", "an", "my", "do", "go", "going", "get", "some", "of", "per", "day", "week"]);
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

// Jaccard similarity over token sets, with an exact-normalized-name shortcut.
export function similarity(a: string, b: string): number {
  if (normalizeTrackerName(a) === normalizeTrackerName(b)) return 1;
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export type ExistingTracker = { id: number; name: string; source?: string | null };
export type DuplicateSuggestion = { id: number; name: string; score: number } | null;

// The best existing tracker that looks like the same thing, if its similarity
// clears the threshold. Also matches a name against a linked source's own
// keyword (e.g. "workout" → a gym_logs-linked tracker) via SOURCE_KEYWORDS.
const SOURCE_KEYWORDS: Record<string, string[]> = {
  gym_logs: ["gym", "workout", "exercise", "lift", "training"],
  leetcode: ["leetcode", "coding", "lc", "algorithms"],
  sleep_hours: ["sleep", "bedtime", "rest"],
  calories: ["calories", "macros", "eating", "diet", "nutrition"],
  savings_rate: ["savings", "save", "budget"],
};

export function findLikelyDuplicate(
  name: string,
  existing: ExistingTracker[],
  threshold = 0.5
): DuplicateSuggestion {
  const nameTokens = new Set(tokens(name));
  let best: DuplicateSuggestion = null;
  for (const t of existing) {
    let score = similarity(name, t.name);
    // A linked source contributes its own keywords: "apply to jobs" style
    // matches are for the LLM pass, but "workout" vs a gym-linked tracker is
    // catchable deterministically here.
    if (t.source && SOURCE_KEYWORDS[t.source]) {
      for (const kw of SOURCE_KEYWORDS[t.source]) {
        if (nameTokens.has(kw)) score = Math.max(score, 0.8);
      }
    }
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: t.id, name: t.name, score };
    }
  }
  return best;
}
