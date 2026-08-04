import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RECONCILE_GRACE_MS,
  buildEventBody,
  findMarkedEvent,
  handleGoogleStatus,
  planTaskEvent,
  shouldReconcile,
  taskMarker,
} from "../lib/tasks/calendar-plan.ts";

// Decision contract for task↔calendar sync. The network wrapper
// (lib/tasks/calendar.ts) stays thin and untested, matching the
// history-core.ts / history.ts split.

const task = (over: Partial<Parameters<typeof planTaskEvent>[1]> = {}) => ({
  title: "call the bank",
  description: null,
  due_at: "2026-07-14",
  gcal_event_id: null,
  ...over,
});

// ---- planTaskEvent -----------------------------------------------------------

test("no Google connection: every intent is a skip", () => {
  for (const intent of ["create", "update", "complete", "delete"] as const) {
    const plan = planTaskEvent(intent, task({ gcal_event_id: "ev1" }), false);
    assert.equal(plan.kind, "skip");
  }
});

test("create: no due date skips, due date creates, existing event skips", () => {
  assert.equal(planTaskEvent("create", task({ due_at: null }), true).kind, "skip");
  assert.equal(planTaskEvent("create", task(), true).kind, "create");
  assert.equal(planTaskEvent("create", task({ gcal_event_id: "ev1" }), true).kind, "skip");
});

test("update: patches when linked, creates when a due date exists but no event yet", () => {
  assert.equal(planTaskEvent("update", task({ gcal_event_id: "ev1" }), true).kind, "update");
  assert.equal(planTaskEvent("update", task(), true).kind, "create");
  assert.equal(planTaskEvent("update", task({ due_at: null }), true).kind, "skip");
});

test("update with due date removed: linked event is closed (deleted)", () => {
  const plan = planTaskEvent("update", task({ due_at: null, gcal_event_id: "ev1" }), true);
  assert.deepEqual(plan, { kind: "close", mode: "deleted" });
});

test("complete/delete: close with the right mode; no linked event skips", () => {
  assert.deepEqual(planTaskEvent("complete", task({ gcal_event_id: "ev1" }), true), {
    kind: "close",
    mode: "completed",
  });
  assert.deepEqual(planTaskEvent("delete", task({ gcal_event_id: "ev1" }), true), {
    kind: "close",
    mode: "deleted",
  });
  assert.equal(planTaskEvent("complete", task(), true).kind, "skip");
  assert.equal(planTaskEvent("delete", task(), true).kind, "skip");
});

// ---- 404 handling ------------------------------------------------------------

test("Google status mapping: 2xx ok, 404/410 forget the link, others error", () => {
  assert.equal(handleGoogleStatus(200), "ok");
  assert.equal(handleGoogleStatus(204), "ok");
  assert.equal(handleGoogleStatus(404), "forget-link");
  assert.equal(handleGoogleStatus(410), "forget-link");
  assert.equal(handleGoogleStatus(500), "error");
  assert.equal(handleGoogleStatus(403), "error");
});

// ---- reconciler eligibility ---------------------------------------------------

const NOW = new Date("2026-07-12T12:00:00.000Z");
const rTask = (over: Partial<Parameters<typeof shouldReconcile>[0]> = {}) => ({
  status: "open",
  due_at: "2026-07-14",
  gcal_event_id: null,
  created_at: "2026-07-12T11:00:00.000Z", // an hour old — past grace
  ...over,
});

test("reconcile: eligible open+due+unlinked task past the grace period", () => {
  assert.equal(shouldReconcile(rTask(), NOW, true), true);
});

test("reconcile: not when Google is disconnected", () => {
  assert.equal(shouldReconcile(rTask(), NOW, false), false);
});

test("reconcile: not for done tasks, dateless tasks, or already-linked tasks", () => {
  assert.equal(shouldReconcile(rTask({ status: "done" }), NOW, true), false);
  assert.equal(shouldReconcile(rTask({ due_at: null }), NOW, true), false);
  assert.equal(shouldReconcile(rTask({ gcal_event_id: "ev1" }), NOW, true), false);
});

test("reconcile grace period: a row younger than 10 minutes is left for sync to fill", () => {
  const fresh = new Date(NOW.getTime() - RECONCILE_GRACE_MS + 60_000).toISOString();
  assert.equal(shouldReconcile(rTask({ created_at: fresh }), NOW, true), false);
  const exactlyAtGrace = new Date(NOW.getTime() - RECONCILE_GRACE_MS).toISOString();
  assert.equal(shouldReconcile(rTask({ created_at: exactlyAtGrace }), NOW, true), true);
});

// ---- marker adoption ----------------------------------------------------------

test("marker adoption: finds the event whose description carries the sync id", () => {
  const syncId = "0b7e9c1a-1111-2222-3333-444455556666";
  const events = [
    { id: "other", description: "unrelated" },
    { id: "mine", description: `Do the thing\n\n${taskMarker(syncId)}` },
    { id: "nodesc" },
  ];
  assert.equal(findMarkedEvent(events, syncId), "mine");
  assert.equal(findMarkedEvent(events, "not-present-id"), null);
  assert.equal(findMarkedEvent([], syncId), null);
});

// ---- event body ---------------------------------------------------------------

test("date-only due date builds an all-day event ending the next day", () => {
  const body = buildEventBody(
    { title: "file taxes", description: "the big folder", due_at: "2026-07-31" },
    "sid-1"
  );
  assert.equal(body.summary, "Task: file taxes");
  assert.deepEqual(body.start, { date: "2026-07-31" });
  assert.deepEqual(body.end, { date: "2026-08-01" });
  assert.ok(body.description.includes("the big folder"));
  assert.ok(body.description.includes("jarvis-task:sid-1"));
  assert.deepEqual(body.reminders.overrides, [{ method: "popup", minutes: 60 }]);
});

test("datetime due date builds a 30-minute timed event", () => {
  const body = buildEventBody(
    { title: "standup", description: null, due_at: "2026-07-14T15:00:00.000Z" },
    "sid-2"
  );
  assert.deepEqual(body.start, { dateTime: "2026-07-14T15:00:00.000Z" });
  assert.deepEqual(body.end, { dateTime: "2026-07-14T15:30:00.000Z" });
  // No task description: the marker is the whole description, no glue lines.
  assert.equal(body.description, "jarvis-task:sid-2");
});

test("all-day end date rolls over month boundaries correctly", () => {
  const body = buildEventBody(
    { title: "x", description: null, due_at: "2026-12-31" },
    "sid-3"
  );
  assert.deepEqual(body.end, { date: "2027-01-01" });
});
