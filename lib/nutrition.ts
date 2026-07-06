import { getDb } from "@/lib/db";
import {
  mealBatchSchema,
  type MealBatch,
  type MealItem,
} from "@/lib/nutrition-schema";

// Nutrition entries arrive from two LLM-adjacent paths (the macro sidecar's
// photo/text extraction and the log_meal agent tool), so the schema gate
// (lib/nutrition-schema.ts) is mandatory: nothing reaches nutrition_logs
// unvalidated.

export { mealBatchSchema, mealItemSchema } from "@/lib/nutrition-schema";
export type { MealBatch, MealItem } from "@/lib/nutrition-schema";

export type NutritionRow = MealItem & {
  id: number;
  date: string;
  source: "photo" | "text";
  created_at: string;
};

export type MacroTotals = { calories: number; protein: number; carbs: number; fat: number };

export function addMeals(batch: MealBatch): number {
  const db = getDb();
  const date = batch.date ?? new Date().toISOString().slice(0, 10);
  const insert = db.prepare(
    `INSERT INTO nutrition_logs (date, item, calories, protein, carbs, fat, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const run = db.transaction(() => {
    for (const e of batch.entries) {
      insert.run(date, e.item, e.calories, e.protein, e.carbs, e.fat, batch.source);
    }
  });
  run();
  return batch.entries.length;
}

export function getDayNutrition(date: string): {
  date: string;
  entries: NutritionRow[];
  totals: MacroTotals;
  calorieGoal: number | null;
} {
  const db = getDb();
  const entries = db
    .prepare(
      `SELECT id, date, item, calories, protein, carbs, fat, source, created_at
       FROM nutrition_logs WHERE date = ? ORDER BY created_at`
    )
    .all(date) as NutritionRow[];
  const totals = entries.reduce<MacroTotals>(
    (acc, e) => ({
      calories: acc.calories + e.calories,
      protein: acc.protein + e.protein,
      carbs: acc.carbs + e.carbs,
      fat: acc.fat + e.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
  const goal = db
    .prepare("SELECT target FROM goals WHERE kind = 'calories_per_day'")
    .get() as { target: number } | undefined;
  return { date, entries, totals, calorieGoal: goal?.target ?? null };
}

export function deleteMeal(id: number): boolean {
  return getDb().prepare("DELETE FROM nutrition_logs WHERE id = ?").run(id).changes > 0;
}
