import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCostUsd, PRICING, type ModelPricing } from "../lib/pricing.ts";

const table: Record<string, ModelPricing> = {
  "test-model": { inputPerMTok: 3, outputPerMTok: 15 },
};

test("cost is exact: tokens × per-million rate", () => {
  // 1M in at $3 + 1M out at $15 = $18
  assert.equal(computeCostUsd("test-model", 1_000_000, 1_000_000, table), 18);
  // 2,000 in = $0.006; 500 out = $0.0075 → $0.0135
  assert.equal(computeCostUsd("test-model", 2_000, 500, table), 0.0135);
  // zero tokens is a real (free) answer, not null
  assert.equal(computeCostUsd("test-model", 0, 0, table), 0);
});

test("unknown model or missing token counts → null, never a guess", () => {
  assert.equal(computeCostUsd("some-new-model", 1000, 1000, table), null);
  assert.equal(computeCostUsd("test-model", null, 1000, table), null);
  assert.equal(computeCostUsd("test-model", 1000, null, table), null);
});

test("the shipped table is deliberately empty — stale pricing is worse than none", () => {
  // If someone fills PRICING in, this test starts checking their entries
  // are sane rather than failing the intent.
  for (const [model, rate] of Object.entries(PRICING)) {
    assert.ok(rate.inputPerMTok > 0 && rate.outputPerMTok > 0, `bad rate for ${model}`);
  }
});
