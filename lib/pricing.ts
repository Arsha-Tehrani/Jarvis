// Per-model pricing for HOSTED providers, in $ per MILLION tokens. Pure
// module (no imports) so `node --test` exercises the math directly.
//
// ⚠ DELIBERATELY EMPTY. Model pricing changes too often to hardcode — a
// stale number silently misreporting cost is worse than an obviously
// missing one (the UI says "pricing not filled in" for unknown models).
// When you point LLM_PROVIDER at Anthropic, copy the current rates for the
// models you use from https://docs.claude.com (Anthropic's pricing page)
// into the table below. Local Ollama never consults this — its cost is
// always recorded as $0.

export type ModelPricing = {
  inputPerMTok: number; // $ per 1,000,000 input tokens
  outputPerMTok: number; // $ per 1,000,000 output tokens
};

export const PRICING: Record<string, ModelPricing> = {
  // Fill in from https://docs.claude.com — e.g. (NOT current numbers):
  // "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  // "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
};

// Dollar cost of one call, or null when it can't be computed honestly:
// unknown model (pricing not filled in) or missing token counts.
export function computeCostUsd(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  table: Record<string, ModelPricing> = PRICING
): number | null {
  const pricing = table[model];
  if (!pricing || inputTokens == null || outputTokens == null) return null;
  return (
    (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000
  );
}
