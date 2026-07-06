import assert from "node:assert/strict";
import { test } from "node:test";
import { mealBatchSchema, mealItemSchema } from "../lib/nutrition-schema.ts";

const burrito = { item: "chicken burrito", calories: 700, protein: 40, carbs: 70, fat: 25 };

test("accepts a well-formed meal item", () => {
  assert.deepEqual(mealItemSchema.parse(burrito), burrito);
});

test("rejects negative, fractional, and absurd macro values", () => {
  assert.equal(mealItemSchema.safeParse({ ...burrito, calories: -100 }).success, false);
  assert.equal(mealItemSchema.safeParse({ ...burrito, protein: 12.5 }).success, false);
  assert.equal(mealItemSchema.safeParse({ ...burrito, calories: 99999 }).success, false);
});

test("rejects missing fields and non-numeric strings from the model", () => {
  const { calories: _dropped, ...missing } = burrito;
  assert.equal(mealItemSchema.safeParse(missing).success, false);
  assert.equal(
    mealItemSchema.safeParse({ ...burrito, calories: "700" }).success,
    false,
    "stringly-typed numbers must not sneak through"
  );
  assert.equal(mealItemSchema.safeParse({ ...burrito, item: "  " }).success, false);
});

test("batch: multi-item meals pass, empty and mis-sourced batches fail", () => {
  const ok = mealBatchSchema.safeParse({
    entries: [burrito, { item: "side salad", calories: 120, protein: 3, carbs: 10, fat: 8 }],
    source: "photo",
    date: "2026-07-06",
  });
  assert.equal(ok.success, true);
  assert.equal(mealBatchSchema.safeParse({ entries: [], source: "text" }).success, false);
  assert.equal(mealBatchSchema.safeParse({ entries: [burrito], source: "api" }).success, false);
  assert.equal(
    mealBatchSchema.safeParse({ entries: [burrito], source: "text", date: "July 6" }).success,
    false
  );
});
