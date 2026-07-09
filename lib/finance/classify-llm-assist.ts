// Network glue for Option B (docs/multi-institution-parsing.md): calls the
// local LLM and delegates parsing/validation to the pure
// classify-llm-assist-schema.ts (same pure/impure split as
// lib/stocks/history-core.ts vs lib/stocks/history.ts). Called ONLY when
// lib/finance/classify.ts's deterministic scorer already returned kind
// "unknown" or a below-floor confidence -- this never overrides a confident
// deterministic verdict. The caller (ingest.ts) treats any result as a
// suggestion requiring an explicit UI confirm step -- never auto-applied.

import { chat } from "@/lib/llm";
import { parseLlmAssistResponse, type LlmAssistSuggestion } from "./classify-llm-assist-schema.ts";

export type { LlmAssistSuggestion } from "./classify-llm-assist-schema.ts";
export { llmAssistSchema } from "./classify-llm-assist-schema.ts";

// Keeps the prompt small; the text passed in has already had account numbers
// redacted upstream (same excerpt classify.ts itself scores), and only the
// first few thousand characters are needed to tell a statement type apart.
const EXCERPT_CHARS = 4000;

export async function suggestClassification(text: string): Promise<LlmAssistSuggestion> {
  const excerpt = text.slice(0, EXCERPT_CHARS);
  const result = await chat({
    messages: [
      {
        role: "system",
        content: [
          "You classify bank/brokerage statement excerpts for a personal finance app.",
          'Respond with ONLY JSON like {"kind":"transaction","subKind":"checking","reason":"..."}. No prose outside the JSON.',
          'kind is one of "brokerage" (holds investments/securities), "transaction" (a bank or credit-card account with dated transactions), or "unknown" if you truly cannot tell.',
          'subKind is one of "checking", "savings", "credit_card", "investment", or null. Use null when kind is "unknown" or you are not confident which sub-type applies. Use "investment" only when kind is "brokerage".',
          "reason is exactly one plain-language sentence naming the specific words or structure in the text that led to your answer.",
        ].join(" "),
      },
      { role: "user", content: excerpt },
    ],
  });
  return parseLlmAssistResponse(result.text ?? "");
}
