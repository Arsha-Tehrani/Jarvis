import assert from "node:assert/strict";
import { test } from "node:test";
import { llmAssistSchema, parseLlmAssistResponse } from "../lib/finance/classify-llm-assist-schema.ts";

// Option B (docs/multi-institution-parsing.md): model output is validated,
// not trusted, same contract as every other LLM-touching path in this
// codebase. These test the validation gate directly -- the model itself is
// never called live in a test (per this project's "LLM calls are never
// tested live" rule; the real live check is recorded in the docs file).

test("accepts a well-formed suggestion", () => {
  const parsed = llmAssistSchema.safeParse({
    kind: "transaction",
    subKind: "checking",
    reason: "Running-balance structure and 'Checking' wording.",
  });
  assert.ok(parsed.success);
});

test("accepts a null subKind (unknown/unsure case)", () => {
  const parsed = llmAssistSchema.safeParse({
    kind: "unknown",
    subKind: null,
    reason: "Not enough information to tell.",
  });
  assert.ok(parsed.success);
});

test("accepts subKind omitted entirely", () => {
  const parsed = llmAssistSchema.safeParse({
    kind: "brokerage",
    reason: "Ticker and share price columns present.",
  });
  assert.ok(parsed.success);
});

test("rejects an invalid kind enum value", () => {
  const parsed = llmAssistSchema.safeParse({
    kind: "savings_account", // not one of the three allowed kinds
    reason: "some reason",
  });
  assert.ok(!parsed.success);
});

test("rejects an invalid subKind enum value", () => {
  const parsed = llmAssistSchema.safeParse({
    kind: "transaction",
    subKind: "money_market", // not one of the four allowed sub-kinds
    reason: "some reason",
  });
  assert.ok(!parsed.success);
});

test("rejects a missing reason", () => {
  const parsed = llmAssistSchema.safeParse({ kind: "transaction", subKind: "checking" });
  assert.ok(!parsed.success);
});

test("rejects an empty-string reason", () => {
  const parsed = llmAssistSchema.safeParse({ kind: "transaction", reason: "" });
  assert.ok(!parsed.success);
});

test("rejects a non-object payload (e.g. the model returning a bare string)", () => {
  const parsed = llmAssistSchema.safeParse("transaction");
  assert.ok(!parsed.success);
});

test("rejects extra hallucinated fields being required in place of the real shape", () => {
  // Not literally an extra-fields check (zod objects allow unknown keys by
  // default) -- this asserts the required shape still can't be satisfied by
  // a plausible-looking but wrong-keyed model reply.
  const parsed = llmAssistSchema.safeParse({ type: "transaction", explanation: "looks like a bank" });
  assert.ok(!parsed.success);
});

// --- parseLlmAssistResponse: the raw-text extraction + parse + validate
// pipeline a real chat() response goes through, without any network call.

test("parses a well-formed model reply with no surrounding prose", () => {
  const suggestion = parseLlmAssistResponse(
    '{"kind":"transaction","subKind":"checking","reason":"running-balance structure"}'
  );
  assert.equal(suggestion.kind, "transaction");
  assert.equal(suggestion.subKind, "checking");
});

test("extracts JSON even when the model adds stray prose around it", () => {
  const suggestion = parseLlmAssistResponse(
    'Sure, here is my answer:\n{"kind":"brokerage","reason":"ticker and share price columns"}\nHope that helps!'
  );
  assert.equal(suggestion.kind, "brokerage");
});

test("throws a clear error when the reply has no JSON object at all", () => {
  assert.throws(() => parseLlmAssistResponse("I'm not sure what this is."), /no JSON object/);
});

test("throws a clear error when the reply has a brace-balanced but syntactically invalid JSON body", () => {
  assert.throws(() => parseLlmAssistResponse('{"kind": "transaction",}'), /not valid JSON/);
});

test("throws a clear error when well-formed JSON fails the zod gate", () => {
  assert.throws(
    () => parseLlmAssistResponse('{"kind":"maybe","reason":"not sure"}'),
    /failed validation/
  );
});
