import assert from "node:assert/strict";
import { test } from "node:test";
import { reanalyzeUiReducer, type ReanalyzePending } from "../lib/finance/reanalyze-ui-state.ts";

// Repro case: click Re-Analyze on one statement (single opens), then click
// Re-Analyze All — the bug was both cards staying on screen instead of All
// replacing the single one.
test("open single then open all replaces single with all", () => {
  let state: ReanalyzePending = null;
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 1 });
  assert.deepEqual(state, { type: "single", statementId: 1 });
  state = reanalyzeUiReducer(state, { type: "open_all" });
  assert.deepEqual(state, { type: "all" });
});

test("open single on one statement then a different statement replaces it", () => {
  let state: ReanalyzePending = null;
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 1 });
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 2 });
  assert.deepEqual(state, { type: "single", statementId: 2 });
});

test("open all then open single on any statement replaces all", () => {
  let state: ReanalyzePending = null;
  state = reanalyzeUiReducer(state, { type: "open_all" });
  assert.deepEqual(state, { type: "all" });
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 5 });
  assert.deepEqual(state, { type: "single", statementId: 5 });
});

test("confirm/close on all leaves nothing pending, no stale single card", () => {
  let state: ReanalyzePending = null;
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 1 });
  state = reanalyzeUiReducer(state, { type: "open_all" });
  state = reanalyzeUiReducer(state, { type: "close" });
  assert.equal(state, null);
});

test("cancel one then the other type can still be opened cleanly afterward", () => {
  let state: ReanalyzePending = null;
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 1 });
  state = reanalyzeUiReducer(state, { type: "close" });
  assert.equal(state, null);
  state = reanalyzeUiReducer(state, { type: "open_all" });
  assert.deepEqual(state, { type: "all" });
});

test("close on an already-null state is a no-op", () => {
  const state = reanalyzeUiReducer(null, { type: "close" });
  assert.equal(state, null);
});
