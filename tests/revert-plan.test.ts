import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVERTIBLE_TOOLS,
  planRevert,
  revertRefusalReason,
} from "../lib/revert-plan.ts";

const DAY = "2026-07-06";

test("add_task inverse tombstones the newest agent-added task with that title", () => {
  const plan = planRevert("add_task", { title: "Call the bank" }, DAY);
  // Synced table → tombstone UPDATE, not a hard DELETE (the removal must
  // propagate through sync).
  assert.match(plan.sql, /UPDATE tasks SET deleted_at/);
  assert.match(plan.sql, /sync_dirty = 1/);
  assert.match(plan.sql, /source = 'agent'/);
  assert.match(plan.sql, /MAX\(id\)/);
  assert.deepEqual(plan.params, ["Call the bank"]);
  assert.match(plan.description, /Call the bank/);
});

test("date-keyed tools use the explicit date arg when present", () => {
  const plan = planRevert("log_gym", { date: "2026-07-01" }, DAY);
  assert.deepEqual(plan.params, ["2026-07-01"]);
});

test("date-keyed tools fall back to the log row's date, not today", () => {
  // Args logged without a date mean the handler used "today" at execution
  // time — which is the log row's created_at date.
  const gym = planRevert("log_gym", {}, "2026-06-30");
  assert.deepEqual(gym.params, ["2026-06-30"]);
  const lc = planRevert("log_leetcode", { count: 2 }, "2026-06-30");
  assert.deepEqual(lc.params, ["2026-06-30"]);
});

test("log_metric inverse targets date + kind", () => {
  const plan = planRevert("log_metric", { kind: "sleep_hours", value: 7.5 }, DAY);
  // health_logs is NOT synced — stays a genuine hard delete.
  assert.match(plan.sql, /DELETE FROM health_logs WHERE date = \? AND kind = \?/);
  assert.deepEqual(plan.params, [DAY, "sleep_hours"]);
});

test("synced-table inverses tombstone; unsynced-table inverses hard-delete", () => {
  for (const [tool, args] of [
    ["log_gym", {}],
    ["log_leetcode", {}],
    ["log_habit", { name: "x" }],
  ] as const) {
    const plan = planRevert(tool, args, DAY);
    assert.match(plan.sql, /SET deleted_at/, `${tool} must tombstone`);
    assert.doesNotMatch(plan.sql, /^DELETE/, `${tool} must not hard-delete`);
  }
  for (const [tool, args] of [
    ["log_meal", { item: "x" }],
    ["log_metric", { kind: "mood" }],
  ] as const) {
    const plan = planRevert(tool, args, DAY);
    assert.match(plan.sql, /^DELETE FROM/, `${tool} (unsynced) stays a hard delete`);
  }
});

test("log_habit inverse resolves the habit id case-insensitively", () => {
  const plan = planRevert("log_habit", { name: "Meditate" }, DAY);
  assert.match(plan.sql, /LOWER\(name\) = LOWER\(\?\)/);
  assert.deepEqual(plan.params, [DAY, "Meditate"]);
});

test("log_meal inverse deletes only the newest matching row", () => {
  const plan = planRevert("log_meal", { item: "chicken burrito", calories: 700 }, DAY);
  assert.match(plan.sql, /MAX\(id\)/);
  assert.deepEqual(plan.params, ["chicken burrito", DAY]);
});

test("add_application and add_to_reading_list invert by their identifying fields", () => {
  const app = planRevert("add_application", { company: "Acme", role: "SWE" }, DAY);
  assert.deepEqual(app.params, ["Acme", "SWE"]);
  const read = planRevert("add_to_reading_list", { title: "SICP" }, DAY);
  assert.deepEqual(read.params, ["SICP"]);
});

test("every inverse is a single parameterized statement (no string interpolation)", () => {
  const samples: Record<string, Record<string, unknown>> = {
    add_task: { title: "x" },
    log_gym: {},
    log_leetcode: {},
    log_metric: { kind: "mood" },
    log_habit: { name: "x" },
    log_meal: { item: "x" },
    add_application: { company: "x", role: "y" },
    add_to_reading_list: { title: "x" },
    complete_task: { task_id: 7 },
  };
  for (const tool of REVERTIBLE_TOOLS) {
    const plan = planRevert(tool, samples[tool], DAY);
    // Adds invert by DELETE; complete_task inverts by a guarded UPDATE
    // (reopen). Either way: one statement, only ? placeholders.
    assert.match(plan.sql.trim(), /^(DELETE FROM|UPDATE) /, `${tool} must be DELETE or UPDATE`);
    const placeholders = (plan.sql.match(/\?/g) ?? []).length;
    assert.equal(placeholders, plan.params.length, `${tool} placeholder/param count`);
  }
});

test("complete_task inverse reopens the task and asks for the calendar rename-back", () => {
  const plan = planRevert("complete_task", { task_id: 7 }, DAY);
  assert.match(plan.sql, /completed_at = NULL/);
  assert.match(plan.sql, /status = 'open'/);
  assert.match(plan.sql, /completed_at IS NOT NULL/); // already-open = no-op
  assert.deepEqual(plan.params, [7]);
  assert.deepEqual(plan.after, { kind: "reopen-task-event", taskId: 7 });
  assert.throws(() => planRevert("complete_task", {}, DAY), /missing numeric "task_id"/);
});

test("update_task is refused with an overwrite reason", () => {
  assert.throws(() => planRevert("update_task", { task_id: 1 }, DAY), /overwritten/);
});

test("unrevertible tools are refused with a reason, never guessed", () => {
  for (const tool of ["set_goal", "append_note", "create_calendar_event", "log_contact", "revert_action"]) {
    assert.throws(() => planRevert(tool, {}, DAY), new RegExp(tool));
    assert.ok(revertRefusalReason(tool).length > 5);
  }
  assert.throws(() => planRevert("no_such_tool", {}, DAY));
});

test("missing identifying args and bad fallback dates are hard errors", () => {
  assert.throws(() => planRevert("add_task", {}, DAY), /missing "title"/);
  assert.throws(() => planRevert("log_meal", { calories: 1 }, DAY), /missing "item"/);
  assert.throws(() => planRevert("log_gym", {}, "yesterday"), /invalid fallback date/);
});
