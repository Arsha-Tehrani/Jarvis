// Pure half of Option B (docs/multi-institution-parsing.md): the zod gate
// and response-parsing logic, with no network/chat() import at all -- so it
// stays loadable by the plain `node --test` runner, same split as
// lib/stocks/history-core.ts (pure) vs lib/stocks/history.ts (network glue).

import { z } from "zod";

export const llmAssistSchema = z.object({
  kind: z.enum(["brokerage", "transaction", "unknown"]),
  subKind: z.enum(["checking", "savings", "credit_card", "investment"]).nullable().optional(),
  reason: z.string().min(1).max(500),
});

export type LlmAssistSuggestion = z.infer<typeof llmAssistSchema>;

// Extracts, parses, and zod-validates a model's raw text reply. Throws with
// a clear reason on any malformed shape -- unvalidated output never reaches
// the caller.
export function parseLlmAssistResponse(raw: string): LlmAssistSuggestion {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("LLM response contained no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("LLM response was not valid JSON");
  }
  const validated = llmAssistSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`LLM response failed validation: ${z.prettifyError(validated.error)}`);
  }
  return validated.data;
}
