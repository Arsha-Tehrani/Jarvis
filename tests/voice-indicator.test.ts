import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveVoiceIndicator } from "../lib/sidecars/voice-indicator.ts";

test("no status yet (haven't fetched, or not in the response) reads as needs-setup", () => {
  assert.equal(deriveVoiceIndicator(undefined), "needs-setup");
});

test("running with a ready venv reads as ready", () => {
  assert.equal(deriveVoiceIndicator({ state: "running", readiness: "ready" }), "ready");
});

test("starting reads as starting even with a ready venv", () => {
  assert.equal(deriveVoiceIndicator({ state: "starting", readiness: "ready" }), "starting");
});

test("stopped with a ready venv reads as down (safe to auto-start)", () => {
  assert.equal(deriveVoiceIndicator({ state: "stopped", readiness: "ready" }), "down");
});

test("crashed with a ready venv reads as down (safe to auto-start again)", () => {
  assert.equal(deriveVoiceIndicator({ state: "crashed", readiness: "ready" }), "down");
});

test("not-set-up readiness reads as needs-setup regardless of state", () => {
  assert.equal(deriveVoiceIndicator({ state: "stopped", readiness: "not-set-up" }), "needs-setup");
});

test("incomplete readiness (missing packages) reads as needs-setup", () => {
  assert.equal(deriveVoiceIndicator({ state: "stopped", readiness: "incomplete" }), "needs-setup");
});

test("not-installed state reads as needs-setup even without a readiness field", () => {
  assert.equal(deriveVoiceIndicator({ state: "not-installed" }), "needs-setup");
});

test("running takes priority even if readiness is momentarily stale-missing", () => {
  assert.equal(deriveVoiceIndicator({ state: "running" }), "ready");
});
