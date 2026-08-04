import assert from "node:assert/strict";
import { test } from "node:test";
import {
  importLogInitialState,
  reanalyzeUiReducer,
  type ImportLogUiState,
} from "../lib/finance/reanalyze-ui-state.ts";

// The statement list lives in a dialog, so the reducer's pending-action
// invariant now travels with a logOpen flag. Opening a confirmation happens
// with the log open in practice; these tests model that.
function openLog(state: ImportLogUiState = importLogInitialState): ImportLogUiState {
  return reanalyzeUiReducer(state, { type: "open_log" });
}

// Repro case: click Re-Analyze on one statement (single opens), then click
// Re-Analyze All — the bug was both cards staying on screen instead of All
// replacing the single one.
test("open single then open all replaces single with all", () => {
  let state = openLog();
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 1 });
  assert.deepEqual(state.pending, { type: "single", statementId: 1 });
  state = reanalyzeUiReducer(state, { type: "open_all" });
  assert.deepEqual(state.pending, { type: "all" });
  assert.equal(state.logOpen, true);
});

test("open single on one statement then a different statement replaces it", () => {
  let state = openLog();
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 1 });
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 2 });
  assert.deepEqual(state.pending, { type: "single", statementId: 2 });
});

test("open all then open single on any statement replaces all", () => {
  let state = openLog();
  state = reanalyzeUiReducer(state, { type: "open_all" });
  assert.deepEqual(state.pending, { type: "all" });
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 5 });
  assert.deepEqual(state.pending, { type: "single", statementId: 5 });
});

test("confirm/close on all leaves nothing pending, no stale single card", () => {
  let state = openLog();
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 1 });
  state = reanalyzeUiReducer(state, { type: "open_all" });
  state = reanalyzeUiReducer(state, { type: "close" });
  assert.equal(state.pending, null);
  assert.equal(state.logOpen, true); // closing a card doesn't close the log
});

test("cancel one then the other type can still be opened cleanly afterward", () => {
  let state = openLog();
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 1 });
  state = reanalyzeUiReducer(state, { type: "close" });
  assert.equal(state.pending, null);
  state = reanalyzeUiReducer(state, { type: "open_all" });
  assert.deepEqual(state.pending, { type: "all" });
});

test("close on an already-null pending is a no-op", () => {
  const state = reanalyzeUiReducer(openLog(), { type: "close" });
  assert.equal(state.pending, null);
});

// fix-plan-3 Phase 2 — the log-dialog cases.
test("open log then open single inside it, close log also clears the pending single", () => {
  let state = openLog();
  state = reanalyzeUiReducer(state, { type: "open_single", statementId: 3 });
  assert.deepEqual(state, { logOpen: true, pending: { type: "single", statementId: 3 } });
  state = reanalyzeUiReducer(state, { type: "close_log" });
  assert.deepEqual(state, { logOpen: false, pending: null });
});

test("close log with a pending all clears it — no stale card on reopen", () => {
  let state = openLog();
  state = reanalyzeUiReducer(state, { type: "open_all" });
  state = reanalyzeUiReducer(state, { type: "close_log" });
  assert.deepEqual(state, { logOpen: false, pending: null });
  state = reanalyzeUiReducer(state, { type: "open_log" });
  assert.deepEqual(state, { logOpen: true, pending: null });
});

test("open_log is idempotent and never resurrects a cleared pending", () => {
  let state = reanalyzeUiReducer(importLogInitialState, { type: "open_log" });
  state = reanalyzeUiReducer(state, { type: "open_log" });
  assert.deepEqual(state, { logOpen: true, pending: null });
});
