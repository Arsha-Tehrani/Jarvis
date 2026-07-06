import { z } from "zod";

// Pure schema module (no DB import) so node --test can exercise the
// validation gate directly — this is what stands between LLM output (macro
// sidecar or log_meal tool) and the nutrition_logs table.

export const mealItemSchema = z.object({
  item: z.string().trim().min(1).max(200).describe("What was eaten, e.g. 'chicken burrito'"),
  calories: z.number().int().min(0).max(10_000),
  protein: z.number().int().min(0).max(1_000).describe("grams"),
  carbs: z.number().int().min(0).max(1_000).describe("grams"),
  fat: z.number().int().min(0).max(1_000).describe("grams"),
});

export type MealItem = z.infer<typeof mealItemSchema>;

export const mealBatchSchema = z.object({
  entries: z.array(mealItemSchema).min(1).max(20),
  source: z.enum(["photo", "text"]),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional(),
});

export type MealBatch = z.infer<typeof mealBatchSchema>;
