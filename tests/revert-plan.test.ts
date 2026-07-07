import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVERTIBLE_TOOLS,
  planRevert,
  revertRefusalReason,
} from "../lib/revert-plan.ts";

const DAY = "2026-07-06";

test("add_task inverse deletes the newest agent-added task with that title", () => {
  const plan = planRevert("add_task", { title: "Call the bank" }, DAY);
  assert.match(plan.sql, /DELETE FROM tasks/);
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
  assert.match(plan.sql, /DELETE FROM health_logs WHERE date = \? AND kind = \?/);
  assert.deepEqual(plan.params, [DAY, "sleep_hours"]);
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

test("every inverse is a single parameterized DELETE (no string interpolation)", () => {
  const samples: Record<string, Record<string, unknown>> = {
    add_task: { title: "x" },
    log_gym: {},
    log_leetcode: {},
    log_metric: { kind: "mood" },
    log_habit: { name: "x" },
    log_meal: { item: "x" },
    add_application: { company: "x", role: "y" },
    add_to_reading_list: { title: "x" },
  };
  for (const tool of REVERTIBLE_TOOLS) {
    const plan = planRevert(tool, samples[tool], DAY);
    assert.match(plan.sql.trim(), /^DELETE FROM /, `${tool} must be a DELETE`);
    const placeholders = (plan.sql.match(/\?/g) ?? []).length;
    assert.equal(placeholders, plan.params.length, `${tool} placeholder/param count`);
  }
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
