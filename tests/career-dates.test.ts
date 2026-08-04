import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationDateSchema, resolveDateApplied } from "../lib/career-dates.ts";

test("accepts a valid ISO date", () => {
  const r = applicationDateSchema.safeParse("2026-07-01");
  assert.equal(r.success, true);
  assert.equal(r.data, "2026-07-01");
});

test("accepts omitted (undefined) — the default-to-today case", () => {
  const r = applicationDateSchema.safeParse(undefined);
  assert.equal(r.success, true);
  assert.equal(r.data, undefined);
});

test("rejects garbage strings", () => {
  for (const bad of ["last Tuesday", "07/01/2026", "2026-7-1", "2026-07-01T12:00:00Z", ""]) {
    assert.equal(applicationDateSchema.safeParse(bad).success, false, `should reject "${bad}"`);
  }
});

test("resolveDateApplied passes a provided date through unchanged", () => {
  assert.equal(resolveDateApplied("2025-12-31"), "2025-12-31");
});

test("resolveDateApplied defaults missing to today (execution-time, not schema)", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(resolveDateApplied(undefined), today);
  assert.equal(resolveDateApplied(null), today);
});
