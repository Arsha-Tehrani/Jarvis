import { z } from "zod";
import { chat } from "@/lib/llm";
import {
  CATEGORIES,
  categorizeByRules,
  categoryReference,
  explainCategory,
  forcedCategory,
  INVESTMENT_TRANSFER,
  matchedRule,
  type Category,
  type CategoryExplanation,
} from "@/lib/finance/categorize-rules";

// Categorization: LLM first (only merchant/amount lines — never full
// statements), keyword rules as the always-working fallback so ingest
// succeeds even with no model running. The deterministic rules live in the
// pure categorize-rules.ts module (unit-tested); this file is the LLM seam.

// Re-export the pure API so existing importers of "@/lib/finance/categorize"
// keep working.
export {
  CATEGORIES,
  categorizeByRules,
  categoryReference,
  explainCategory,
  forcedCategory,
  INVESTMENT_TRANSFER,
  matchedRule,
};
export type { Category, CategoryExplanation };

type Line = { id: number; description: string; amount: number };

export type CategorizeOutcome = {
  categories: Map<number, Category>;
  source: "llm" | "rules" | "llm+rules";
  llmError?: string;
};

const BATCH_SIZE = 40;

const llmResponseSchema = z.array(
  z.object({ id: z.number().int(), category: z.enum(CATEGORIES) })
);

export async function categorizeTransactions(lines: Line[]): Promise<CategorizeOutcome> {
  const categories = new Map<number, Category>();
  let llmError: string | undefined;
  let usedLlm = false;

  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, i + BATCH_SIZE);
    if (!llmError) {
      try {
        const result = await categorizeBatchLlm(batch);
        for (const [id, cat] of result) categories.set(id, cat);
        usedLlm = true;
        continue;
      } catch (err) {
        llmError = err instanceof Error ? err.message : "LLM categorization failed";
        console.error("[finance] LLM categorization failed, falling back to rules:", llmError);
      }
    }
    for (const line of batch) {
      categories.set(line.id, categorizeByRules(line.description, line.amount));
    }
  }

  // Any ids the LLM skipped get rule-based categories.
  let filledByRules = false;
  for (const line of lines) {
    if (!categories.has(line.id)) {
      categories.set(line.id, categorizeByRules(line.description, line.amount));
      filledByRules = true;
    }
  }

  // Authoritative overrides run LAST: a brokerage ACH is an investment
  // contribution no matter what the model guessed, so "Amount Invested" is a
  // reliable deterministic sum instead of leaking into Transfer/Other.
  for (const line of lines) {
    const forced = forcedCategory(line.description);
    if (forced) categories.set(line.id, forced);
  }

  const source = usedLlm ? (llmError || filledByRules ? "llm+rules" : "llm") : "rules";
  return { categories, source, llmError };
}

async function categorizeBatchLlm(batch: Line[]): Promise<Map<number, Category>> {
  const listing = batch
    .map((l) => `${l.id}\t${l.description}\t${l.amount.toFixed(2)}`)
    .join("\n");
  const result = await chat({
    messages: [
      {
        role: "system",
        content: [
          "You categorize bank transactions.",
          `Allowed categories: ${CATEGORIES.join(", ")}.`,
          "Input lines are: id<TAB>description<TAB>amount (negative = money out).",
          'Respond with ONLY a JSON array like [{"id":1,"category":"Groceries"}] covering every id. No prose.',
        ].join(" "),
      },
      { role: "user", content: listing },
    ],
  });
  const text = result.text ?? "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("LLM response contained no JSON array");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("LLM response was not valid JSON");
  }
  const validated = llmResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`LLM response failed validation: ${z.prettifyError(validated.error)}`);
  }
  const map = new Map<number, Category>();
  const validIds = new Set(batch.map((l) => l.id));
  for (const row of validated.data) {
    if (validIds.has(row.id)) map.set(row.id, row.category);
  }
  return map;
}
// (rules + explainers live in categorize-rules.ts; re-exported at the top)

